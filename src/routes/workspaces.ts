// src/routes/workspaces.ts
import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/db/client";
import { requireAuth } from "@/middleware/auth";
import { AppError } from "@/middleware/errorHandler";
import { PlanType, WorkspaceStatus } from "@prisma/client";

const router = Router();
router.use(requireAuth);

const CreateSchema = z.object({
  name:       z.string().min(1).max(80),
  client:     z.string().min(1).max(80),
  plan:       z.nativeEnum(PlanType).optional(),
  gatewayUrl: z.string().url().optional(),
});

const UpdateSchema = CreateSchema.partial().extend({
  status: z.nativeEnum(WorkspaceStatus).optional(),
});

// ── GET /api/workspaces ──────────────────────────────────────
router.get("/", async (_req, res, next) => {
  try {
    const workspaces = await prisma.workspace.findMany({
      orderBy: { createdAt: "asc" },
      include: {
        _count: {
          select: { agents: true, channels: true, secrets: true },
        },
        // Latest usage record
        usageRecords: {
          orderBy: { date: "desc" },
          take: 1,
        },
      },
    });

    const result = workspaces.map((ws) => ({
      id:            ws.id,
      name:          ws.name,
      client:        ws.client,
      plan:          ws.plan,
      status:        ws.status,
      agentCount:    ws._count.agents,
      channelCount:  ws._count.channels,
      secretCount:   ws._count.secrets,
      todayMessages: ws.usageRecords[0]?.messages ?? 0,
      monthCostNTD:  ws.usageRecords[0]?.costNTD  ?? 0,
      createdAt:     ws.createdAt,
    }));

    res.json(result);
  } catch (e) { next(e); }
});

// ── GET /api/workspaces/:id ──────────────────────────────────
router.get("/:id", async (req, res, next) => {
  try {
    const ws = await prisma.workspace.findUnique({
      where: { id: req.params.id },
      include: {
        agents:   { select: { id: true, name: true, status: true } },
        channels: { include: { channel: true } },
        secrets:  { select: { id: true, name: true, status: true, expiresAt: true } },
      },
    });
    if (!ws) throw new AppError(404, "Workspace not found");
    res.json(ws);
  } catch (e) { next(e); }
});

// ── POST /api/workspaces ─────────────────────────────────────
router.post("/", async (req, res, next) => {
  try {
    const body = CreateSchema.safeParse(req.body);
    if (!body.success) throw new AppError(400, body.error.message);

    const ws = await prisma.workspace.create({ data: body.data });
    res.status(201).json(ws);
  } catch (e) { next(e); }
});

// ── PATCH /api/workspaces/:id ────────────────────────────────
router.patch("/:id", async (req, res, next) => {
  try {
    const body = UpdateSchema.safeParse(req.body);
    if (!body.success) throw new AppError(400, body.error.message);

    const ws = await prisma.workspace.update({
      where: { id: req.params.id },
      data:  body.data,
    });
    res.json(ws);
  } catch (e) { next(e); }
});

// ── DELETE /api/workspaces/:id ───────────────────────────────
router.delete("/:id", async (req, res, next) => {
  try {
    await prisma.workspace.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (e) { next(e); }
});

// ── POST /api/workspaces/:id/backup ─────────────────────────
router.post("/:id/backup", async (req, res, next) => {
  try {
    const ws = await prisma.workspace.findUnique({
      where: { id: req.params.id },
      include: {
        agents:       { include: { toolBindings: true, promptTemplates: true } },
        channels:     { include: { channel: true, allowlist: true } },
        secrets:      true,
        tools:        true,
        skills:       true,
      },
    });
    if (!ws) throw new AppError(404, "Workspace not found");

    const backup = await prisma.workspaceBackup.create({
      data: {
        workspaceId:  ws.id,
        note:         req.body.note ?? null,
        snapshotJson: ws as object,
      },
    });
    res.status(201).json(backup);
  } catch (e) { next(e); }
});

// ── GET /api/workspaces/:id/backups ─────────────────────────
router.get("/:id/backups", async (req, res, next) => {
  try {
    const backups = await prisma.workspaceBackup.findMany({
      where:   { workspaceId: req.params.id },
      select:  { id: true, note: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    });
    res.json(backups);
  } catch (e) { next(e); }
});

export default router;
