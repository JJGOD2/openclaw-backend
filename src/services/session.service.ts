// src/services/session.service.ts
// 對話 Session 管理服務
// 負責：取得/建立 session、追加訊息、組裝歷史 context、session 摘要壓縮
import { prisma } from "@/db/client";
import { MessageRole } from "@prisma/client";

// ── 每個 session 最多帶入幾條歷史訊息進 Claude ───────────────
const MAX_HISTORY_MESSAGES = 20;

// ── 單則訊息最大長度（防止超長訊息佔滿 context window）────────
const MAX_MESSAGE_CHARS = 2000;

// ── Session 閒置超過此時間後開新 session（分鐘）─────────────
const SESSION_IDLE_MINUTES = 30;

export interface SessionContext {
  sessionId:  string;
  isNew:      boolean;
  history:    { role: "user" | "assistant"; content: string }[];
}

// ─────────────────────────────────────────────────────────────
// 取得或建立 Session
// ─────────────────────────────────────────────────────────────
export async function getOrCreateSession(params: {
  workspaceId: string;
  agentId:     string;
  platform:    string;
  userId:      string;
}): Promise<SessionContext> {
  const { workspaceId, agentId, platform, userId } = params;

  // 找到現有的 active session
  const existing = await prisma.conversationSession.findUnique({
    where: {
      workspaceId_agentId_platform_userId: { workspaceId, agentId, platform, userId },
    },
    include: {
      messages: {
        orderBy: { createdAt: "asc" },
        take:    MAX_HISTORY_MESSAGES * 2,       // 多取一些，後面再 trim
      },
    },
  });

  // 判斷是否 idle 過久 → 開新 session
  if (existing && existing.isActive) {
    const idleMs    = Date.now() - existing.lastActiveAt.getTime();
    const idleMins  = idleMs / 60_000;

    if (idleMins > SESSION_IDLE_MINUTES) {
      // 標記舊 session 為 inactive，下面會建新的
      await prisma.conversationSession.update({
        where: { id: existing.id },
        data:  { isActive: false },
      });
    } else {
      // 回傳現有 session + 歷史
      const history = buildHistory(existing.messages);
      return { sessionId: existing.id, isNew: false, history };
    }
  }

  // 建立新 session（先 delete unique constraint 的舊 inactive record 或 upsert）
  const session = await prisma.conversationSession.upsert({
    where: {
      workspaceId_agentId_platform_userId: { workspaceId, agentId, platform, userId },
    },
    update: {
      isActive:     true,
      messageCount: 0,
      lastActiveAt: new Date(),
      title:        null,
      updatedAt:    new Date(),
    },
    create: { workspaceId, agentId, platform, userId, isActive: true },
  });

  return { sessionId: session.id, isNew: true, history: [] };
}

// ─────────────────────────────────────────────────────────────
// 追加訊息到 session
// ─────────────────────────────────────────────────────────────
export async function appendMessages(
  sessionId: string,
  messages:  { role: MessageRole; content: string; metadata?: object }[]
): Promise<void> {
  // Batch insert
  await prisma.conversationMessage.createMany({
    data: messages.map((m) => ({
      sessionId,
      role:       m.role,
      content:    truncate(m.content),
      tokenCount: estimateTokens(m.content),
      metadata:   m.metadata,
    })),
  });

  // Update session stats
  const lastMsg = messages[messages.length - 1];
  const isFirst = messages.some((m) => m.role === "USER");

  await prisma.conversationSession.update({
    where: { id: sessionId },
    data: {
      messageCount: { increment: messages.length },
      lastActiveAt: new Date(),
      // Auto-title from first user message
      ...(isFirst ? {
        title: lastMsg.role === "USER"
          ? messages.find((m) => m.role === "USER")?.content.slice(0, 60)
          : undefined,
      } : {}),
    },
  });
}

// ─────────────────────────────────────────────────────────────
// 取得完整 session 歷史（帶入 Claude 的格式）
// ─────────────────────────────────────────────────────────────
export async function getSessionHistory(sessionId: string) {
  const messages = await prisma.conversationMessage.findMany({
    where:   { sessionId },
    orderBy: { createdAt: "asc" },
    take:    MAX_HISTORY_MESSAGES * 2,
  });
  return buildHistory(messages);
}

// ─────────────────────────────────────────────────────────────
// 清除 Session（用於「重新開始對話」）
// ─────────────────────────────────────────────────────────────
export async function clearSession(params: {
  workspaceId: string;
  agentId:     string;
  platform:    string;
  userId:      string;
}): Promise<void> {
  const session = await prisma.conversationSession.findUnique({
    where: { workspaceId_agentId_platform_userId: params },
  });
  if (!session) return;

  // 軟刪除訊息，保留 session 記錄
  await prisma.conversationMessage.deleteMany({ where: { sessionId: session.id } });
  await prisma.conversationSession.update({
    where: { id: session.id },
    data:  { messageCount: 0, isActive: true, lastActiveAt: new Date(), title: null },
  });
}

// ─────────────────────────────────────────────────────────────
// 壓縮超長 session（摘要化舊訊息，保留最新 N 條）
// 當 messageCount 超過 MAX_HISTORY_MESSAGES * 2 時觸發
// ─────────────────────────────────────────────────────────────
export async function maybeCompressSession(
  sessionId:    string,
  compressWith: (messages: string) => Promise<string>   // 傳入 Claude summarizer function
): Promise<void> {
  const count = await prisma.conversationMessage.count({ where: { sessionId } });
  if (count <= MAX_HISTORY_MESSAGES * 2) return;

  // 取最舊的一半訊息
  const oldMessages = await prisma.conversationMessage.findMany({
    where:   { sessionId },
    orderBy: { createdAt: "asc" },
    take:    MAX_HISTORY_MESSAGES,
  });

  // 組裝成文字給 Claude 摘要
  const transcript = oldMessages
    .map((m) => `[${m.role}]: ${m.content}`)
    .join("\n");

  const summary = await compressWith(transcript);

  // 刪除舊訊息，插入摘要 system message
  await prisma.$transaction([
    prisma.conversationMessage.deleteMany({
      where: { sessionId, id: { in: oldMessages.map((m) => m.id) } },
    }),
    prisma.conversationMessage.create({
      data: {
        sessionId,
        role:    "SYSTEM",
        content: `[對話摘要] ${summary}`,
        metadata: { compressed: true, originalCount: oldMessages.length },
      },
    }),
  ]);
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function buildHistory(
  messages: { role: string; content: string }[]
): { role: "user" | "assistant"; content: string }[] {
  return messages
    .filter((m) => m.role !== "SYSTEM")          // SYSTEM messages are injected differently
    .slice(-MAX_HISTORY_MESSAGES)                // keep last N
    .map((m) => ({
      role:    m.role === "USER" ? "user" : "assistant",
      content: truncate(m.content),
    }));
}

function truncate(text: string): string {
  return text.length > MAX_MESSAGE_CHARS
    ? text.slice(0, MAX_MESSAGE_CHARS) + "…（已截斷）"
    : text;
}

function estimateTokens(text: string): number {
  // 粗估：中文 ~1.5 char/token，英文 ~4 char/token，取中間值 2.5
  return Math.ceil(text.length / 2.5);
}
