// src/services/agent.service.ts  (v2 — with conversation memory)
import { prisma } from "@/db/client";
import { decryptSecret } from "@/lib/crypto";
import { getOrCreateSession, appendMessages, maybeCompressSession } from "@/services/session.service";
import { getModelConfig }  from "@/services/model.service";
import { buildRagContext }  from "@/services/rag/rag.service";
import { withCache, CacheKey, invalidateAgent, TTL } from "@/lib/cache/cache";
import { withCircuitBreaker, CIRCUITS } from "@/lib/circuit-breaker";
import { autoTranslateIfNeeded } from "@/services/media/translate.service";
export interface AgentInvokeInput {
  workspaceId: string;
  agentId:     string;
  userId:      string;
  platform:    string;
  text:        string;
  replyToken?: string;
  sessionId?:  string;
}

export interface AgentInvokeResult {
  reply:         string;
  shouldQueue:   boolean;
  queueId?:      string;
  toolsUsed:     string[];
  sessionId:     string;
  isNewSession:  boolean;
  tokenEstimate: number;
}

export async function invokeAgent(input: AgentInvokeInput): Promise<AgentInvokeResult> {
  const agent = await prisma.agent.findUnique({
    where: { id: input.agentId },
    include: { workspace: true, toolBindings: { include: { tool: true } } },
  });
  if (!agent) throw new Error(`Agent ${input.agentId} not found`);

  const secretRow = await prisma.secret.findUnique({
    where: { workspaceId_name: { workspaceId: input.workspaceId, name: "ANTHROPIC_API_KEY" } },
  });
  const apiKey = secretRow?.encryptedValue.startsWith("PLACEHOLDER")
    ? (process.env.ANTHROPIC_API_KEY ?? "")
    : secretRow ? decryptSecret(secretRow.encryptedValue) : "";

  // ── Session / Memory ──────────────────────────────────────
  const session = await getOrCreateSession({
    workspaceId: input.workspaceId,
    agentId:     input.agentId,
    platform:    input.platform,
    userId:      input.userId,
  });
  const sessionId = input.sessionId ?? session.sessionId;

  // ── Load model config ───────────────────────────────────
  const modelCfg = await getModelConfig(input.workspaceId, input.agentId);

  // ── Build prompt ─────────────────────────────────────────
  const base = agent.systemPrompt?.trim() || `你是 ${agent.name}，${agent.role}。`;
  const toolList = agent.toolBindings.length > 0
    ? `\n\n可用工具：${agent.toolBindings.map(tb => tb.tool.name).join("、")}` : "";
  const platformHint: Record<string,string> = {
    LINE:     "請用親切、簡潔的繁體中文回覆，適合 LINE 訊息格式，避免過長段落。",
    TELEGRAM: "請用清楚、結構化的繁體中文回覆，可使用 Markdown 格式。",
    SLACK:    "請用專業、簡潔的繁體中文回覆，適合工作場合。",
  };
  // ── Auto-translate incoming message if needed ────────────
  const workspaceLang = "zh-TW";   // TODO: make this a workspace setting
  const translationResult = await autoTranslateIfNeeded(input.text, workspaceLang);
  const effectiveText = translationResult.translated;
  if (translationResult.didTranslate) {
    await prisma.logEntry.create({
      data: {
        workspaceId: input.workspaceId, type: "SYSTEM",
        message: `[翻譯] ${translationResult.sourceLang}→${workspaceLang}：「${input.text.slice(0,40)}」→「${effectiveText.slice(0,40)}」`,
      },
    });
  }

  // ── RAG: find relevant knowledge ────────────────────────
  const ragKBs = await prisma.knowledgeBase.findMany({
    where: { workspaceId: input.workspaceId, agentIds: { has: input.agentId } },
    select: { id: true },
  });
  const ragContext = ragKBs.length
    ? await buildRagContext(ragKBs.map(k => k.id), effectiveText)
    : "";

  const systemPrompt = `${base}${ragContext}${toolList}\n\n${platformHint[input.platform.toUpperCase()] ?? "請用繁體中文回覆。"}\n\n你正在進行一段持續的對話，請記住之前的對話內容，保持上下文連貫性。`;

  // ── Build messages array with history ────────────────────
  const allMessages: { role: "user"|"assistant"; content: string }[] = [
    ...session.history,
    { role: "user", content: input.text },
  ];

  // ── Call Claude ───────────────────────────────────────────
  let reply = "非常抱歉，目前系統忙碌中，請稍後再試。";
  let promptTokens = 0;
  let outputTokens = 0;

  try {
    const response = await withCircuitBreaker(CIRCUITS.CLAUDE_API, () => fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:      modelCfg.modelId,
        max_tokens: modelCfg.maxTokens,
        system:     systemPrompt,
        messages:   allMessages,
        temperature: modelCfg.temperature,
        ...(modelCfg.topP !== null ? { top_p: modelCfg.topP } : {}),
      }),
    });
    if (!response.ok) throw new Error(await response.text());
    const data    = await response.json();
    reply         = data.content?.[0]?.text ?? "（無回應）";
    promptTokens  = data.usage?.input_tokens  ?? 0;
    outputTokens  = data.usage?.output_tokens ?? 0;
  } catch (err) {
    await prisma.logEntry.create({
      data: { workspaceId: input.workspaceId, type: "ERROR",
        message: `[Agent] Claude API 失敗：${(err as Error).message}` },
    });
  }

  // ── Persist messages ──────────────────────────────────────
  await appendMessages(sessionId, [
    { role: "USER",      content: input.text, metadata: { platform: input.platform, userId: input.userId } },
    { role: "ASSISTANT", content: reply,       metadata: { promptTokens, outputTokens } },
  ]);

  // ── Maybe compress session ───────────────────────────────
  await maybeCompressSession(sessionId, async (transcript) => {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type":"application/json","x-api-key":apiKey,"anthropic-version":"2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001", max_tokens: 512,
        messages: [{ role:"user", content:`請用 200 字以內摘要這段對話的重點：\n\n${transcript}` }],
      }),
    });
    const d = await res.json();
    return d.content?.[0]?.text ?? transcript.slice(0, 200);
  });

  // ── Review queue ──────────────────────────────────────────
  const highRisk  = agent.toolBindings.filter(tb => tb.tool.requireApproval && tb.tool.risk === "HIGH");
  const needsReview = highRisk.length > 0 && /退款|取消|刪除|退貨/.test(input.text);
  let queueId: string | undefined;
  if (needsReview) {
    const review = await prisma.reviewQueue.create({
      data: { workspaceId: input.workspaceId, agentId: input.agentId,
        platform: input.platform, userId: input.userId,
        userMessage: input.text, aiDraft: reply,
        replyToken: input.replyToken, status: "PENDING" },
    });
    queueId = review.id;
  }

  // ── Log ───────────────────────────────────────────────────
  await prisma.logEntry.create({
    data: {
      workspaceId: input.workspaceId, type: "CHAT",
      message: `[${input.platform}] ${input.userId} → ${agent.name}：「${input.text.slice(0,60)}」`,
      metadata: { agentId: input.agentId, sessionId, isNewSession: session.isNew,
        platform: input.platform, needsReview, promptTokens, outputTokens },
    },
  });

  // ── Update usage ──────────────────────────────────────────
  const today = new Date(); today.setHours(0,0,0,0);
  await prisma.usageRecord.upsert({
    where:  { workspaceId_date: { workspaceId: input.workspaceId, date: today } },
    update: { inputTokens:{increment:promptTokens}, outputTokens:{increment:outputTokens},
               messages:{increment:1}, apiCalls:{increment:1} },
    create: { workspaceId:input.workspaceId, date:today,
               inputTokens:promptTokens, outputTokens, messages:1, apiCalls:1 },
  });

  return {
    reply, shouldQueue: needsReview, queueId,
    toolsUsed:    agent.toolBindings.map(tb => tb.tool.name),
    sessionId, isNewSession: session.isNew,
    tokenEstimate: promptTokens + outputTokens,
  };
}
