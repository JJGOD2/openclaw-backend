// src/routes/public-api.ts
// 對外開放 API — 使用 API Key 認證（x-api-key header）
// 供第三方系統整合（報表、CRM、自動化工具）
import { Router } from "express";
import { prisma } from "@/db/client";
import { authenticateApiKey } from "@/routes/admin/api-keys";
import { AppError } from "@/middleware/errorHandler";

const router = Router();

// All public API routes require API key
router.use(authenticateApiKey as unknown as import("express").RequestHandler);

// ── GET /public/v1/workspaces ─────────────────────────────────
router.get("/workspaces", async (_req, res, next) => {
  try {
    const ws = await prisma.workspace.findMany({
      select: {
        id: true, name: true, client: true, plan: true, status: true, createdAt: true,
        _count: { select: { agents: true, channels: true } },
      },
    });
    res.json({ data: ws, count: ws.length });
  } catch (e) { next(e); }
});

// ── GET /public/v1/workspaces/:id/usage ──────────────────────
router.get("/workspaces/:id/usage", async (req, res, next) => {
  try {
    const days   = Math.min(Number(req.query.days ?? 30), 90);
    const since  = new Date();
    since.setDate(since.getDate() - days);

    const records = await prisma.usageRecord.findMany({
      where:   { workspaceId: req.params.id, date: { gte: since } },
      orderBy: { date: "asc" },
      select: { date: true, inputTokens: true, outputTokens: true, messages: true, costNTD: true },
    });

    const totals = records.reduce(
      (acc, r) => ({
        tokens:   acc.tokens  + r.inputTokens + r.outputTokens,
        messages: acc.messages + r.messages,
        costNTD:  acc.costNTD  + Number(r.costNTD),
      }),
      { tokens: 0, messages: 0, costNTD: 0 }
    );

    res.json({ workspaceId: req.params.id, days, totals, records });
  } catch (e) { next(e); }
});

// ── GET /public/v1/workspaces/:id/logs ───────────────────────
router.get("/workspaces/:id/logs", async (req, res, next) => {
  try {
    const limit  = Math.min(Number(req.query.limit ?? 50), 200);
    const logs   = await prisma.logEntry.findMany({
      where:   { workspaceId: req.params.id },
      orderBy: { createdAt: "desc" },
      take:    limit,
      select: { id: true, type: true, message: true, createdAt: true },
    });
    res.json({ data: logs, count: logs.length });
  } catch (e) { next(e); }
});

// ── GET /public/v1/workspaces/:id/agents ─────────────────────
router.get("/workspaces/:id/agents", async (req, res, next) => {
  try {
    const agents = await prisma.agent.findMany({
      where:  { workspaceId: req.params.id },
      select: { id: true, name: true, role: true, status: true },
    });
    res.json({ data: agents, count: agents.length });
  } catch (e) { next(e); }
});

// ── POST /public/v1/workspaces/:id/messages ──────────────────
// 對外訊息注入 API（READ_WRITE scope 以上才能使用）
router.post("/workspaces/:id/messages", async (req, res, next) => {
  try {
    const scopeReq = (req as unknown as { apiKeyScope: string }).apiKeyScope;
    if (scopeReq === "READ_ONLY" || scopeReq === "WEBHOOK_ONLY") {
      throw new AppError(403, "READ_WRITE or FULL_ACCESS scope required");
    }

    const { agentId, platform, userId, text } = req.body;
    if (!agentId || !platform || !userId || !text) {
      throw new AppError(400, "agentId, platform, userId, text are required");
    }

    const { invokeAgent } = await import("@/services/agent.service");
    const result = await invokeAgent({
      workspaceId: req.params.id,
      agentId, platform, userId, text,
    });

    res.json({ reply: result.reply, queued: result.shouldQueue, queueId: result.queueId });
  } catch (e) { next(e); }
});

// ── GET /public/v1/review ────────────────────────────────────
router.get("/review", async (req, res, next) => {
  try {
    const { status, limit } = req.query;
    const items = await prisma.reviewQueue.findMany({
      where:   status ? { status: String(status).toUpperCase() as never } : {},
      orderBy: { createdAt: "desc" },
      take:    Math.min(Number(limit ?? 20), 100),
      select:  { id: true, platform: true, userId: true, userMessage: true,
                 aiDraft: true, status: true, createdAt: true },
    });
    res.json({ data: items, count: items.length });
  } catch (e) { next(e); }
});

export default router;
