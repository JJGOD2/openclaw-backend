// src/routes/sessions/index.ts
import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/db/client";
import { requireAuth } from "@/middleware/auth";
import { AppError } from "@/middleware/errorHandler";
import { clearSession, getSessionHistory } from "@/services/session.service";

const router = Router();
router.use(requireAuth);

// ── GET /api/sessions?workspaceId=&agentId=&userId=&platform= ─
// 查詢 sessions 列表（後台檢視所有用戶對話）
router.get("/", async (req, res, next) => {
  try {
    const q = z.object({
      workspaceId: z.string().cuid().optional(),
      agentId:     z.string().cuid().optional(),
      userId:      z.string().optional(),
      platform:    z.string().optional(),
      isActive:    z.enum(["true","false"]).optional(),
      limit:       z.coerce.number().min(1).max(100).default(20),
      cursor:      z.string().optional(),
    }).safeParse(req.query);
    if (!q.success) throw new AppError(400, q.error.message);

    const { workspaceId, agentId, userId, platform, isActive, limit, cursor } = q.data;

    const sessions = await prisma.conversationSession.findMany({
      where: {
        ...(workspaceId ? { workspaceId }           : {}),
        ...(agentId     ? { agentId }               : {}),
        ...(userId      ? { userId }                : {}),
        ...(platform    ? { platform }              : {}),
        ...(isActive !== undefined ? { isActive: isActive === "true" } : {}),
      },
      orderBy: { lastActiveAt: "desc" },
      take:    limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: {
        _count:    { select: { messages: true } },
        workspace: { select: { client: true, name: true } },
      },
    });

    const hasMore    = sessions.length > limit;
    const items      = hasMore ? sessions.slice(0, limit) : sessions;
    const nextCursor = hasMore ? items[items.length - 1].id : null;

    // Summary stats
    const stats = await prisma.conversationSession.groupBy({
      by:    ["platform"],
      where: workspaceId ? { workspaceId } : {},
      _count: true,
    });

    res.json({ items, nextCursor, stats });
  } catch (e) { next(e); }
});

// ── GET /api/sessions/:id — session detail + messages ────────
router.get("/:id", async (req, res, next) => {
  try {
    const session = await prisma.conversationSession.findUnique({
      where:   { id: req.params.id },
      include: {
        workspace: { select: { client: true, name: true } },
        messages:  { orderBy: { createdAt: "asc" } },
      },
    });
    if (!session) throw new AppError(404, "Session not found");
    res.json(session);
  } catch (e) { next(e); }
});

// ── GET /api/sessions/:id/history — history for Claude format ─
router.get("/:id/history", async (req, res, next) => {
  try {
    const history = await getSessionHistory(req.params.id);
    res.json(history);
  } catch (e) { next(e); }
});

// ── DELETE /api/sessions/:id/messages — clear session memory ──
router.delete("/:id/messages", async (req, res, next) => {
  try {
    const session = await prisma.conversationSession.findUnique({
      where: { id: req.params.id },
    });
    if (!session) throw new AppError(404, "Session not found");

    await clearSession({
      workspaceId: session.workspaceId,
      agentId:     session.agentId,
      platform:    session.platform,
      userId:      session.userId,
    });

    res.json({ ok: true, message: "Session 記憶已清除" });
  } catch (e) { next(e); }
});

// ── POST /api/sessions/:id/close — 手動關閉 session ──────────
router.post("/:id/close", async (req, res, next) => {
  try {
    const session = await prisma.conversationSession.update({
      where: { id: req.params.id },
      data:  { isActive: false },
    });
    res.json(session);
  } catch (e) { next(e); }
});

// ── GET /api/sessions/user/:userId — 特定用戶的所有 sessions ──
router.get("/user/:userId", async (req, res, next) => {
  try {
    const { workspaceId } = req.query;
    const sessions = await prisma.conversationSession.findMany({
      where: {
        userId: req.params.userId,
        ...(workspaceId ? { workspaceId: String(workspaceId) } : {}),
      },
      orderBy: { lastActiveAt: "desc" },
      include: { _count: { select: { messages: true } } },
    });
    res.json(sessions);
  } catch (e) { next(e); }
});

export default router;
