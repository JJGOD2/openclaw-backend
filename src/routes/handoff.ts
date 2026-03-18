// src/routes/handoff.ts
import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/db/client";
import { requireAuth, AuthRequest } from "@/middleware/auth";
import { AppError } from "@/middleware/errorHandler";
import { HandoffStatus, HandoffReason } from "@prisma/client";

const router = Router();
router.use(requireAuth);

// GET /api/handoff?workspaceId=&status=
router.get("/", async (req, res, next) => {
  try {
    const { workspaceId, status } = z.object({
      workspaceId: z.string().cuid(),
      status:      z.nativeEnum(HandoffStatus).optional(),
    }).parse(req.query);

    const items = await prisma.handoffQueue.findMany({
      where: {
        workspaceId,
        ...(status ? { status } : {}),
      },
      orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
      take:    50,
    });

    const counts = await prisma.handoffQueue.groupBy({
      by:    ["status"],
      where: { workspaceId },
      _count: true,
    });

    res.json({ items, counts: Object.fromEntries(counts.map(c => [c.status, c._count])) });
  } catch (e) { next(e); }
});

// POST /api/handoff — create handoff manually
router.post("/", async (req: AuthRequest, res, next) => {
  try {
    const body = z.object({
      workspaceId: z.string().cuid(),
      fromAgentId: z.string().cuid().optional(),
      platform:    z.string(),
      userId:      z.string(),
      sessionId:   z.string().optional(),
      reason:      z.nativeEnum(HandoffReason).default("USER_REQUEST"),
      summary:     z.string().min(1),
      priority:    z.number().min(1).max(10).default(5),
    }).parse(req.body);

    const item = await prisma.handoffQueue.create({ data: { ...body, status: "PENDING" } });

    // Broadcast via SSE
    sseManager.broadcast(body.workspaceId, { type:"handoff.created", item });

    res.status(201).json(item);
  } catch (e) { next(e); }
});

// PATCH /api/handoff/:id/accept
router.patch("/:id/accept", async (req: AuthRequest, res, next) => {
  try {
    const item = await prisma.handoffQueue.update({
      where: { id: req.params.id },
      data:  { status: "ACCEPTED", assignedTo: req.userId, acceptedAt: new Date() },
    });
    sseManager.broadcast(item.workspaceId, { type:"handoff.accepted", item });
    res.json(item);
  } catch (e) { next(e); }
});

// PATCH /api/handoff/:id/resolve
router.patch("/:id/resolve", async (req, res, next) => {
  try {
    const item = await prisma.handoffQueue.update({
      where: { id: req.params.id },
      data:  { status: "RESOLVED", resolvedAt: new Date() },
    });
    sseManager.broadcast(item.workspaceId, { type:"handoff.resolved", item });
    res.json(item);
  } catch (e) { next(e); }
});

// PATCH /api/handoff/:id/return — return to AI agent
router.patch("/:id/return", async (req, res, next) => {
  try {
    const item = await prisma.handoffQueue.update({
      where: { id: req.params.id },
      data:  { status: "RETURNED", returnedAt: new Date() },
    });
    res.json(item);
  } catch (e) { next(e); }
});

// ─────────────────────────────────────────────────────────────
// SSE Event Stream  GET /api/events?workspaceId=
// ─────────────────────────────────────────────────────────────
class SSEManager {
  private clients = new Map<string, Set<import("express").Response>>();

  add(workspaceId: string, res: import("express").Response) {
    if (!this.clients.has(workspaceId)) {
      this.clients.set(workspaceId, new Set());
    }
    this.clients.get(workspaceId)!.add(res);
  }

  remove(workspaceId: string, res: import("express").Response) {
    this.clients.get(workspaceId)?.delete(res);
  }

  broadcast(workspaceId: string, data: object) {
    const payload = `data: ${JSON.stringify(data)}\n\n`;
    // Broadcast to specific workspace
    this.clients.get(workspaceId)?.forEach(r => {
      try { r.write(payload); } catch { /* ignore closed */ }
    });
    // Also broadcast to "all" listeners
    this.clients.get("*")?.forEach(r => {
      try { r.write(payload); } catch {}
    });
  }
}

export const sseManager = new SSEManager();

// GET /api/events — SSE endpoint
router.get("/sse", (req: AuthRequest, res, next) => {
  try {
    const wsId = String(req.query.workspaceId ?? "*");

    res.setHeader("Content-Type",  "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection",    "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");   // Disable Nginx buffering
    res.flushHeaders();

    // Send initial connected event
    res.write(`data: ${JSON.stringify({ type:"connected", workspaceId: wsId })}\n\n`);

    sseManager.add(wsId, res);

    // Heartbeat every 25s
    const heartbeat = setInterval(() => {
      try { res.write(": heartbeat\n\n"); } catch { clearInterval(heartbeat); }
    }, 25_000);

    req.on("close", () => {
      clearInterval(heartbeat);
      sseManager.remove(wsId, res);
    });
  } catch (e) { next(e); }
});

export default router;
