// src/services/chain.service.ts
// Agent 鏈式呼叫引擎
// 讓多個 Agent 串行/並行協作完成複雜任務
import { prisma } from "@/db/client";
import { invokeAgent } from "@/services/agent.service";

export interface ChainStep {
  id:       string;
  type:     "AGENT_INVOKE" | "TRANSFORM" | "CONDITION" | "PARALLEL" | "MERGE";
  label:    string;
  agentId?: string;          // for AGENT_INVOKE
  agentIds?:string[];        // for PARALLEL
  prompt?:  string;          // additional prompt prefix
  transformFn?: string;      // JS expression: (input) => output
  condition?: string;        // JS expression: (input) => "yes" | "no"
  mergePrompt?: string;      // prompt to merge parallel results
  outputVar?:   string;      // store result in variable
}

interface ChainContext {
  workspaceId: string;
  userId:      string;
  platform:    string;
  vars:        Record<string, string>;
}

interface ChainResult {
  runId:       string;
  output:      string;
  stepOutputs: Record<string, string>;
  status:      "done" | "failed";
  errorMsg?:   string;
  durationMs:  number;
}

// ─────────────────────────────────────────────────────────────
// Run a chain
// ─────────────────────────────────────────────────────────────
export async function runChain(
  chainId: string,
  input:   string,
  ctx:     ChainContext
): Promise<ChainResult> {
  const chain = await prisma.agentChain.findUnique({ where: { id: chainId } });
  if (!chain) throw new Error(`Chain ${chainId} not found`);

  const steps = chain.stepsJson as ChainStep[];
  const run   = await prisma.chainRun.create({
    data: {
      chainId,
      workspaceId: ctx.workspaceId,
      userId:      ctx.userId,
      platform:    ctx.platform,
      input,
      status:      "running",
    },
  });

  const startMs      = Date.now();
  const stepOutputs: Record<string, string> = {};
  const vars         = { ...ctx.vars, input };   // mutable context
  let   currentText  = input;

  try {
    for (const step of steps) {
      currentText = await executeChainStep(step, currentText, vars, ctx, stepOutputs);
      stepOutputs[step.id] = currentText;
      if (step.outputVar) vars[step.outputVar] = currentText;

      await prisma.chainRun.update({
        where: { id: run.id },
        data:  { stepOutputs },
      });
    }

    const durationMs = Date.now() - startMs;
    await prisma.chainRun.update({
      where: { id: run.id },
      data:  { output: currentText, status: "done", completedAt: new Date(), stepOutputs },
    });
    await prisma.agentChain.update({
      where: { id: chainId },
      data:  { runCount: { increment: 1 } },
    });

    return { runId: run.id, output: currentText, stepOutputs, status: "done", durationMs };

  } catch (err) {
    const errorMsg = (err as Error).message;
    await prisma.chainRun.update({
      where: { id: run.id },
      data:  { status: "failed", errorMsg, completedAt: new Date() },
    });
    return {
      runId: run.id, output: "", stepOutputs,
      status: "failed", errorMsg,
      durationMs: Date.now() - startMs,
    };
  }
}

// ─────────────────────────────────────────────────────────────
// Execute a single chain step
// ─────────────────────────────────────────────────────────────
async function executeChainStep(
  step:        ChainStep,
  input:       string,
  vars:        Record<string, string>,
  ctx:         ChainContext,
  stepOutputs: Record<string, string>
): Promise<string> {
  const interpolated = (t: string) =>
    t.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? stepOutputs[k] ?? "");

  switch (step.type) {
    case "AGENT_INVOKE": {
      if (!step.agentId) throw new Error(`Step ${step.id}: agentId required`);
      const prompt = step.prompt ? `${interpolated(step.prompt)}\n\n${input}` : input;
      const result = await invokeAgent({
        workspaceId: ctx.workspaceId,
        agentId:     step.agentId,
        userId:      `chain_${ctx.userId}`,
        platform:    ctx.platform,
        text:        prompt,
      });
      return result.reply;
    }

    case "TRANSFORM": {
      if (!step.transformFn) return input;
      try {
        // eslint-disable-next-line no-new-func
        const fn = new Function("input", "vars", `"use strict"; return (${step.transformFn})(input, vars);`);
        return String(fn(input, vars));
      } catch (err) {
        throw new Error(`Step ${step.id} transform error: ${(err as Error).message}`);
      }
    }

    case "CONDITION": {
      if (!step.condition) return input;
      try {
        // eslint-disable-next-line no-new-func
        const fn = new Function("input", "vars", `"use strict"; return (${step.condition})(input, vars);`);
        const branch = String(fn(input, vars));
        // For now just log branch; flow control handled at chain level
        console.log(`[Chain] Step ${step.id} condition branch: ${branch}`);
        return input;   // pass through, branch recorded in stepOutputs
      } catch (err) {
        return input;
      }
    }

    case "PARALLEL": {
      if (!step.agentIds?.length) throw new Error(`Step ${step.id}: agentIds required`);
      const results = await Promise.all(
        step.agentIds.map(async (agentId, i) => {
          const prompt = step.prompt ? `${interpolated(step.prompt)}\n\n${input}` : input;
          const result = await invokeAgent({
            workspaceId: ctx.workspaceId,
            agentId,
            userId:      `chain_parallel_${i}_${ctx.userId}`,
            platform:    ctx.platform,
            text:        prompt,
          });
          return result.reply;
        })
      );
      // Return JSON array of results for MERGE step to handle
      return JSON.stringify(results);
    }

    case "MERGE": {
      // Parse parallel results and merge with an agent
      let parts: string[];
      try {
        parts = JSON.parse(input);
      } catch {
        parts = [input];
      }

      const mergeText = parts
        .map((p, i) => `[分析 ${i + 1}]:\n${p}`)
        .join("\n\n---\n\n");

      if (!step.agentId && !step.mergePrompt) {
        return parts.join("\n\n");   // simple concat
      }

      const mergePrompt = step.mergePrompt
        ? `${interpolated(step.mergePrompt)}\n\n${mergeText}`
        : `請整合以下分析結果，提供一個綜合結論：\n\n${mergeText}`;

      if (step.agentId) {
        const result = await invokeAgent({
          workspaceId: ctx.workspaceId,
          agentId:     step.agentId,
          userId:      `chain_merge_${ctx.userId}`,
          platform:    ctx.platform,
          text:        mergePrompt,
        });
        return result.reply;
      }
      return mergeText;
    }

    default:
      return input;
  }
}
