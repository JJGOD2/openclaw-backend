// src/services/orchestration/engine.ts
// 多 Agent 串接執行引擎
import { prisma } from "@/db/client";
import { invokeAgent } from "@/services/agent.service";
import { OrchRunStatus } from "@prisma/client";

// ─────────────────────────────────────────────────────────────
// Step types
// ─────────────────────────────────────────────────────────────
interface BaseStep { id: string; type: string; label?: string }
interface AgentCallStep extends BaseStep {
  type:         "AGENT_CALL";
  agentId:      string;
  inputMapping: string;             // "{{output}}" = previous output, "{{input}}" = original
  outputKey:    string;             // store result under this key in context
}
interface ConditionStep extends BaseStep {
  type:       "CONDITION";
  expression: string;               // eval'd against context: "context.sentiment === 'negative'"
  trueBranch: string;               // step id to jump to
  falseBranch:string;
}
interface TransformStep extends BaseStep {
  type:       "TRANSFORM";
  operation:  "UPPER"|"LOWER"|"TRIM"|"JSON_EXTRACT"|"REGEX"|"TEMPLATE";
  params:     Record<string, string>;
  inputKey:   string;
  outputKey:  string;
}
interface HumanHandoffStep extends BaseStep {
  type:    "HUMAN_HANDOFF";
  reason?: string;
}
interface EndStep extends BaseStep { type: "END" }

type OrchStep = AgentCallStep | ConditionStep | TransformStep | HumanHandoffStep | EndStep;

export interface FlowContext {
  input:      string;
  output:     string;
  [key:string]:unknown;
}

// ─────────────────────────────────────────────────────────────
// Execute a flow
// ─────────────────────────────────────────────────────────────
export async function executeFlow(params: {
  flowId:      string;
  userId:      string;
  sessionId?:  string;
  inputText:   string;
  platform:    string;
}): Promise<{ output: string; status: OrchRunStatus; runId: string }> {

  const flow = await prisma.orchestrationFlow.findUnique({
    where: { id: params.flowId },
  });
  if (!flow) throw new Error(`Flow ${params.flowId} not found`);

  const run = await prisma.orchRun.create({
    data: {
      flowId:    params.flowId,
      sessionId: params.sessionId,
      userId:    params.userId,
      inputText: params.inputText,
      status:    "RUNNING",
      stepsLog:  [],
    },
  });

  const steps    = (flow.stepsJson as OrchStep[]);
  const stepsMap = new Map(steps.map(s => [s.id, s]));
  const stepsLog: object[] = [];
  const ctx: FlowContext = { input: params.inputText, output: params.inputText };

  let currentId  = steps[0]?.id;
  let maxSteps   = 20;    // prevent infinite loops
  let finalStatus: OrchRunStatus = "COMPLETED";
  let finalOutput = params.inputText;

  while (currentId && maxSteps-- > 0) {
    const step = stepsMap.get(currentId);
    if (!step) break;

    const stepStart = Date.now();
    let nextId: string | null = null;
    let stepOutput: unknown   = null;
    let stepError:  string | undefined;

    try {
      switch (step.type) {
        case "AGENT_CALL": {
          const input = interpolate(step.inputMapping, ctx);
          const result = await invokeAgent({
            workspaceId: flow.workspaceId,
            agentId:     step.agentId,
            userId:      params.userId,
            platform:    params.platform,
            text:        input,
            sessionId:   params.sessionId,
          });
          ctx[step.outputKey] = result.reply;
          ctx.output           = result.reply;
          finalOutput          = result.reply;
          stepOutput           = result.reply;
          // Find next step (sequential)
          const idx = steps.findIndex(s => s.id === currentId);
          nextId    = steps[idx + 1]?.id ?? null;
          break;
        }

        case "CONDITION": {
          // Safe eval against context
          const result = safeEval(step.expression, ctx);
          nextId       = result ? step.trueBranch : step.falseBranch;
          stepOutput   = result;
          break;
        }

        case "TRANSFORM": {
          const raw = String(ctx[step.inputKey] ?? ctx.output ?? "");
          let transformed = raw;
          switch (step.operation) {
            case "UPPER":        transformed = raw.toUpperCase(); break;
            case "LOWER":        transformed = raw.toLowerCase(); break;
            case "TRIM":         transformed = raw.trim(); break;
            case "TEMPLATE":     transformed = interpolate(step.params.template ?? raw, ctx); break;
            case "JSON_EXTRACT": {
              try {
                const parsed = JSON.parse(raw);
                const path   = step.params.path?.split(".") ?? [];
                transformed  = path.reduce((o, k) => (o as Record<string,unknown>)?.[k], parsed) as string ?? raw;
              } catch { transformed = raw; }
              break;
            }
            case "REGEX": {
              const match = raw.match(new RegExp(step.params.pattern ?? "(.*)"));
              transformed = match?.[1] ?? raw;
              break;
            }
          }
          ctx[step.outputKey] = transformed;
          ctx.output           = transformed;
          finalOutput          = transformed;
          stepOutput           = transformed;
          const idx = steps.findIndex(s => s.id === currentId);
          nextId    = steps[idx + 1]?.id ?? null;
          break;
        }

        case "HUMAN_HANDOFF": {
          finalStatus = "WAITING_HUMAN";
          stepOutput  = { reason: step.reason ?? "Human review required" };
          nextId      = null;
          break;
        }

        case "END": {
          nextId = null;
          break;
        }
      }
    } catch (err) {
      stepError   = (err as Error).message;
      finalStatus = "FAILED";
      nextId      = null;
    }

    stepsLog.push({
      stepId:     currentId,
      type:       step.type,
      label:      step.label,
      output:     stepOutput,
      error:      stepError,
      latencyMs:  Date.now() - stepStart,
    });

    currentId = nextId ?? null;
  }

  // Update run record
  await prisma.orchRun.update({
    where: { id: run.id },
    data:  {
      status:     finalStatus,
      outputText: finalOutput,
      stepsLog,
      endedAt:    new Date(),
    },
  });

  // Update flow run count
  await prisma.orchestrationFlow.update({
    where: { id: params.flowId },
    data:  { runCount: { increment: 1 } },
  });

  return { output: finalOutput, status: finalStatus, runId: run.id };
}

// ── Helpers ───────────────────────────────────────────────────
function interpolate(template: string, ctx: FlowContext): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => String(ctx[k] ?? ""));
}

function safeEval(expression: string, ctx: FlowContext): boolean {
  try {
    // Whitelist: only allow comparison operators, no function calls
    const safe = expression.replace(/[^a-zA-Z0-9._'"=<>!&|()\s]/g, "");
    // eslint-disable-next-line no-new-func
    return Boolean(new Function("context", `"use strict"; return (${safe});`)(ctx));
  } catch {
    return false;
  }
}
