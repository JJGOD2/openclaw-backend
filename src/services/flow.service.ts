// src/services/flow.service.ts
// 對話流程引擎：解析 JSON 節點圖，逐步執行對話流程
import { prisma } from "@/db/client";
import { invokeAgent } from "@/services/agent.service";
import { FlowNodeType } from "@prisma/client";

export interface FlowNode {
  id:       string;
  type:     FlowNodeType;
  label:    string;
  data:     Record<string, unknown>;
}

export interface FlowEdge {
  from:     string;
  to:       string;
  label?:   string;   // condition branch label e.g. "yes" | "no" | "default"
}

export interface FlowContext {
  userId:      string;
  platform:    string;
  workspaceId: string;
  vars:        Record<string, unknown>;
  lastMessage: string;
}

export interface FlowStepResult {
  done:         boolean;
  reply?:       string;
  nextNodeId?:  string;
  waitForInput: boolean;
}

// ─────────────────────────────────────────────────────────────
// Start or resume a flow run
// ─────────────────────────────────────────────────────────────
export async function runFlow(
  flowId:    string,
  ctx:       FlowContext,
  runId?:    string          // existing run to resume
): Promise<{ reply: string; done: boolean; runId: string }> {
  const flow = await prisma.conversationFlow.findUnique({ where: { id: flowId } });
  if (!flow) throw new Error(`Flow ${flowId} not found`);

  const nodes = flow.nodesJson as FlowNode[];
  const edges = flow.edgesJson as FlowEdge[];

  // Get or create run
  let run = runId
    ? await prisma.flowRun.findUnique({ where: { id: runId } })
    : null;

  if (!run) {
    run = await prisma.flowRun.create({
      data: {
        flowId, workspaceId: ctx.workspaceId,
        userId: ctx.userId, platform: ctx.platform,
        state: ctx.vars, currentNodeId: null,
      },
    });
  }

  // Find start node or next node
  const startNode = run.currentNodeId
    ? nodes.find(n => n.id === run!.currentNodeId)
    : nodes.find(n => n.type === "START");

  if (!startNode) {
    return { reply: "（流程已結束）", done: true, runId: run.id };
  }

  const replies: string[] = [];
  let   current = startNode;
  const state   = { ...(run.state as Record<string, unknown>), ...ctx.vars,
                    lastMessage: ctx.lastMessage, userId: ctx.userId };

  // Execute nodes sequentially until we need user input or reach END
  for (let steps = 0; steps < 20; steps++) {
    const result = await executeNode(current, state, ctx);
    if (result.reply) replies.push(result.reply);

    // Update state with any new variables
    Object.assign(state, result.newVars ?? {});

    if (result.done || !result.nextNodeId) {
      // Mark run as completed
      await prisma.flowRun.update({
        where: { id: run.id },
        data:  { completed: true, completedAt: new Date(), state },
      });
      await prisma.conversationFlow.update({
        where: { id: flowId },
        data:  { stats: { runs: 1, completions: 1 } as never },
      });
      return { reply: replies.join("\n"), done: true, runId: run.id };
    }

    // Resolve next node
    const nextEdge = edges.find(e => e.from === current.id && (
      !e.label || e.label === result.branch || e.label === "default"
    ));
    if (!nextEdge) break;

    const nextNode = nodes.find(n => n.id === nextEdge.to);
    if (!nextNode) break;

    // If next node needs user input, pause and save state
    if (needsInput(nextNode)) {
      await prisma.flowRun.update({
        where: { id: run.id },
        data:  { currentNodeId: nextNode.id, state },
      });
      return {
        reply: replies.join("\n"),
        done:  false,
        runId: run.id,
      };
    }
    current = nextNode;
  }

  return { reply: replies.join("\n") || "（流程處理中）", done: false, runId: run.id };
}

// ─────────────────────────────────────────────────────────────
// Execute a single node
// ─────────────────────────────────────────────────────────────
async function executeNode(
  node:  FlowNode,
  state: Record<string, unknown>,
  ctx:   FlowContext
): Promise<{ reply?: string; done?: boolean; branch?: string; nextNodeId?: string; newVars?: Record<string, unknown> }> {
  const d = node.data;

  switch (node.type) {
    case "START":
      return {};

    case "END":
      return { done: true };

    case "MESSAGE": {
      const text = interpolate(String(d.text ?? ""), state);
      return { reply: text };
    }

    case "CONDITION": {
      const variable = String(state[String(d.variable ?? "")] ?? "");
      const operator = String(d.operator ?? "equals");
      const value    = String(d.value ?? "");

      let matches = false;
      switch (operator) {
        case "equals":       matches = variable === value; break;
        case "contains":     matches = variable.includes(value); break;
        case "starts_with":  matches = variable.startsWith(value); break;
        case "greater_than": matches = Number(variable) > Number(value); break;
        case "less_than":    matches = Number(variable) < Number(value); break;
        case "not_empty":    matches = variable.trim().length > 0; break;
      }
      return { branch: matches ? "yes" : "no" };
    }

    case "SET_VARIABLE": {
      const newVars: Record<string, unknown> = {};
      const key   = String(d.key ?? "");
      const value = interpolate(String(d.value ?? ""), state);
      if (key) newVars[key] = value;
      return { newVars };
    }

    case "API_CALL": {
      try {
        const url = interpolate(String(d.url ?? ""), state);
        const r   = await fetch(url, {
          method:  String(d.method ?? "GET"),
          headers: d.headers as HeadersInit ?? {},
          body:    d.method !== "GET" ? JSON.stringify(d.body ?? {}) : undefined,
          signal:  AbortSignal.timeout(8000),
        });
        const text = await r.text();
        let parsed: unknown;
        try { parsed = JSON.parse(text); } catch { parsed = text; }
        const key = String(d.resultVar ?? "api_result");
        return { newVars: { [key]: parsed }, branch: r.ok ? "success" : "error" };
      } catch (err) {
        return { branch: "error", newVars: { api_error: (err as Error).message } };
      }
    }

    case "AGENT_INVOKE": {
      const agentId = String(d.agentId ?? "");
      if (!agentId) return { reply: "（Agent 未設定）" };
      const result = await invokeAgent({
        workspaceId: ctx.workspaceId,
        agentId,
        userId:   ctx.userId,
        platform: ctx.platform,
        text:     String(state.lastMessage ?? state.userInput ?? ""),
      });
      return { reply: result.reply, branch: result.shouldQueue ? "queued" : "done" };
    }

    case "HANDOFF": {
      const reason  = String(d.reason ?? "USER_REQUEST");
      const summary = String(d.summary ?? `用戶 ${ctx.userId} 請求人工協助`);
      await prisma.handoffQueue.create({
        data: {
          workspaceId:  ctx.workspaceId,
          fromAgentId:  d.agentId as string | undefined,
          platform:     ctx.platform,
          userId:       ctx.userId,
          reason:       reason as never,
          summary:      interpolate(summary, state),
          transcript:   state.transcript ? state.transcript as never : [],
          priority:     Number(d.priority ?? 5),
          status:       "PENDING",
        },
      });
      const msg = interpolate(
        String(d.message ?? "您的請求已轉交給客服人員，請稍候。"),
        state
      );
      return { reply: msg, done: true };
    }

    default:
      return {};
  }
}

function needsInput(node: FlowNode): boolean {
  return ["AGENT_INVOKE"].includes(node.type) && !node.data.autoRun;
}

function interpolate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? ""));
}
