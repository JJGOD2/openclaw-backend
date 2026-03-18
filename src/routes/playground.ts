// src/routes/playground.ts
// Agent 測試沙箱 — 直接在後台測試 Agent 回應，不需通道
import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/db/client";
import { requireAuth } from "@/middleware/auth";
import { AppError } from "@/middleware/errorHandler";
import { invokeAgent } from "@/services/agent.service";

const router = Router();
router.use(requireAuth);

// ── POST /api/playground/chat ─────────────────────────────────
// 傳送測試訊息，回傳 Agent 回覆（不儲存到真實 session）
router.post("/chat", async (req, res, next) => {
  try {
    const Schema = z.object({
      workspaceId: z.string().cuid(),
      agentId:     z.string().cuid(),
      message:     z.string().min(1).max(2000),
      sessionId:   z.string().optional(),    // 可傳 sessionId 保持對話連貫
      platform:    z.string().default("PLAYGROUND"),
    });
    const body = Schema.safeParse(req.body);
    if (!body.success) throw new AppError(400, body.error.message);

    const startTime = Date.now();

    const result = await invokeAgent({
      workspaceId: body.data.workspaceId,
      agentId:     body.data.agentId,
      userId:      `playground_${req.userId}`,
      platform:    body.data.platform,
      text:        body.data.message,
      sessionId:   body.data.sessionId,
    });

    res.json({
      reply:         result.reply,
      sessionId:     result.sessionId,
      isNewSession:  result.isNewSession,
      tokenEstimate: result.tokenEstimate,
      latencyMs:     Date.now() - startTime,
      toolsUsed:     result.toolsUsed,
      shouldQueue:   result.shouldQueue,
    });
  } catch (e) { next(e); }
});

// ── POST /api/playground/reset ────────────────────────────────
// 重置 playground session
router.post("/reset", async (req, res, next) => {
  try {
    const { workspaceId, agentId } = z.object({
      workspaceId: z.string().cuid(),
      agentId:     z.string().cuid(),
    }).parse(req.body);

    const { clearSession } = await import("@/services/session.service");
    await clearSession({
      workspaceId,
      agentId,
      platform: "PLAYGROUND",
      userId:   `playground_${req.userId}`,
    });

    res.json({ ok: true, message: "對話已重置" });
  } catch (e) { next(e); }
});

// ── GET /api/playground/agents?workspaceId= ───────────────────
// 取得可測試的 agent 列表
router.get("/agents", async (req, res, next) => {
  try {
    const { workspaceId } = z.object({ workspaceId: z.string().cuid() }).parse(req.query);
    const agents = await prisma.agent.findMany({
      where:   { workspaceId, status: { not: "DISABLED" } },
      select:  { id: true, name: true, role: true, description: true, systemPrompt: true,
                 toolBindings: { include: { tool: { select: { name: true, risk: true } } } } },
      orderBy: { name: "asc" },
    });
    res.json(agents);
  } catch (e) { next(e); }
});

export default router;
