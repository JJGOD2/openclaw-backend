import { prisma } from "@/db/client";
import { decryptSecret } from "@/lib/crypto";
import { getOrCreateSession, appendMessages, maybeCompressSession } from "@/services/session.service";
import { getModelConfig } from "@/services/model.service";
import { withCache, CacheKey, TTL } from "@/lib/cache/cache";

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
  sessionId:     string;
  isNewSession:  boolean;
  tokenEstimate: number;
  toolsUsed:     string[];
  shouldQueue:   boolean;
  queueId?:      string;
}

export async function invokeAgent(input: AgentInvokeInput): Promise<AgentInvokeResult> {
  // ── Load agent ────────────────────────────────────────────
  const agent = await withCache(
    CacheKey.agent(input.agentId),
    () => prisma.agent.findUnique({
      where:   { id: input.agentId },
      include: {
        toolBindings: { include: { tool: true } },
        workspace:    { select: { id: true, plan: true } },
      },
    }),
    TTL.MEDIUM
  );

  if (!agent) throw new Error(`Agent ${input.agentId} not found`);

  // ── Auto-translate if needed ──────────────────────────────
  let effectiveText = input.text;
  try {
    const { autoTranslateIfNeeded } = await import("@/services/media/translate.service");
    const result = await autoTranslateIfNeeded(input.text, "zh-TW");
    effectiveText = result.translated;
  } catch {
    // Translation optional - continue with original text
  }

  // ── RAG context ───────────────────────────────────────────
  let ragContext = "";
  try {
    const kbIds = await prisma.knowledgeBase.findMany({
      where:  { workspaceId: input.workspaceId, agentIds: { has: input.agentId } },
      select: { id: true },
    });
    if (kbIds.length > 0) {
      const { buildRagContext } = await import("@/services/rag/rag.service");
      ragContext = await buildRagContext(kbIds.map(k => k.id), effectiveText);
    }
  } catch {
    // RAG optional - continue without context
  }

  // ── Load model config ─────────────────────────────────────
  const modelCfg = await getModelConfig(input.workspaceId, input.agentId);

  // ── Build system prompt ───────────────────────────────────
  const toolList = agent.toolBindings.length > 0
    ? `\n\n你可以使用以下工具：${agent.toolBindings.map(tb => tb.tool.name).join(", ")}`
    : "";
  const systemPrompt = `${agent.systemPrompt}${ragContext}${toolList}`;

  // ── Session / memory ──────────────────────────────────────
  const { session, isNew } = await getOrCreateSession({
    workspaceId: input.workspaceId,
    agentId:     input.agentId,
    platform:    input.platform,
    userId:      input.userId,
    sessionId:   input.sessionId,
  });

  const history = await prisma.conversationMessage.findMany({
    where:   { sessionId: session.id },
    orderBy: { createdAt: "asc" },
    take:    20,
    select:  { role: true, content: true },
  });

  const allMessages = [
    ...history.map(m => ({ role: m.role.toLowerCase() as "user" | "assistant", content: m.content })),
    { role: "user" as const, content: effectiveText },
  ];

  // ── Call AI API (OpenRouter) ──────────────────────────────
  const apiKey  = process.env.OPENROUTER_API_KEY ?? "";
  const model   = process.env.OPENROUTER_MODEL   ?? "anthropic/claude-3-5-sonnet";
  let reply        = "抱歉，目前無法回覆，請稍後再試。";
  let promptTokens = 0;
  let outputTokens = 0;

  const messagesWithSystem = [
    { role: "system" as const, content: systemPrompt },
    ...allMessages,
  ];

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "HTTP-Referer":  process.env.BACKEND_URL ?? "https://mywrapper.ai",
        "X-Title":       "MyWrapper Technologies",
      },
      body: JSON.stringify({
        model,
        max_tokens:  modelCfg.maxTokens ?? 1000,
        messages:    messagesWithSystem,
        temperature: modelCfg.temperature ?? 0.7,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) throw new Error(await response.text());
    const data   = await response.json();
    reply        = data.choices?.[0]?.message?.content ?? "（無回應）";
    promptTokens = data.usage?.prompt_tokens     ?? 0;
    outputTokens = data.usage?.completion_tokens ?? 0;
  } catch (err) {
    await prisma.logEntry.create({
      data: {
        workspaceId: input.workspaceId,
        type: "ERROR",
        message: `[Agent] ${agent.name} 呼叫失敗: ${(err as Error).message}`,
      },
    }).catch(() => {});
  }

  // ── Check review queue ────────────────────────────────────
  const binding = await prisma.agentChannelBinding.findFirst({
    where: { agentId: input.agentId },
    select: { requireHumanReview: true },
  }).catch(() => null);

  const shouldQueue = binding?.requireHumanReview ?? false;
  let queueId: string | undefined;

  if (shouldQueue) {
    const qi = await prisma.reviewQueue.create({
      data: {
        workspaceId:  input.workspaceId,
        agentId:      input.agentId,
        platform:     input.platform,
        userId:       input.userId,
        sessionId:    session.id,
        userMessage:  input.text,
        aiDraft:      reply,
        status:       "PENDING",
        replyToken:   input.replyToken,
      },
    }).catch(() => null);
    queueId = qi?.id;
  }

  // ── Persist messages ──────────────────────────────────────
  await appendMessages(session.id, [
    { role: "USER",      content: input.text, tokenCount: promptTokens },
    { role: "ASSISTANT", content: reply,      tokenCount: outputTokens },
  ]);

  await maybeCompressSession(session.id, input.workspaceId);

  // ── Log ───────────────────────────────────────────────────
  await prisma.logEntry.create({
    data: {
      workspaceId: input.workspaceId,
      type:        "CHAT",
      message:     `[${input.platform}] ${input.userId} → ${agent.name}: ${input.text.slice(0, 80)}`,
      metadata:    { agentId: input.agentId, sessionId: session.id, tokens: promptTokens + outputTokens },
    },
  }).catch(() => {});

  // ── Usage record ──────────────────────────────────────────
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  await prisma.usageRecord.upsert({
    where:  { workspaceId_date: { workspaceId: input.workspaceId, date: today } },
    update: {
      messages:     { increment: 1 },
      inputTokens:  { increment: promptTokens },
      outputTokens: { increment: outputTokens },
      apiCalls:     { increment: 1 },
    },
    create: {
      workspaceId:  input.workspaceId,
      date:         today,
      messages:     1,
      inputTokens:  promptTokens,
      outputTokens: outputTokens,
      apiCalls:     1,
      toolExecs:    0,
      costNTD:      0,
    },
  }).catch(() => {});

  return {
    reply:         shouldQueue ? "您的訊息已收到，客服人員將盡快回覆。" : reply,
    sessionId:     session.id,
    isNewSession:  isNew,
    tokenEstimate: promptTokens + outputTokens,
    toolsUsed:     [],
    shouldQueue,
    queueId,
  };
}
