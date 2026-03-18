// src/routes/agents.ts
import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/db/client";
import { requireAuth } from "@/middleware/auth";
import { AppError } from "@/middleware/errorHandler";
import { AgentStatus } from "@prisma/client";

const router = Router();
router.use(requireAuth);

const AgentSchema = z.object({
  workspaceId:  z.string().cuid(),
  name:         z.string().min(1).max(50),
  initials:     z.string().min(1).max(4),
  role:         z.string().min(1).max(80),
  description:  z.string().max(500).optional(),
  systemPrompt: z.string().max(8000).optional(),
  replyStyle:   z.string().optional(),
  status:       z.nativeEnum(AgentStatus).optional(),
});

// GET /api/agents?workspaceId=xxx
router.get("/", async (req, res, next) => {
  try {
    const { workspaceId } = req.query;
    const agents = await prisma.agent.findMany({
      where:   workspaceId ? { workspaceId: String(workspaceId) } : undefined,
      orderBy: { createdAt: "asc" },
      include: {
        workspace: { select: { name: true, client: true } },
        toolBindings: { include: { tool: { select: { name: true } } } },
        channelBindings: {
          include: {
            binding: { include: { channel: { select: { type: true, displayName: true } } } },
          },
        },
      },
    });

    const result = agents.map((a) => ({
      id:            a.id,
      name:          a.name,
      initials:      a.initials,
      role:          a.role,
      description:   a.description,
      status:        a.status,
      workspaceId:   a.workspaceId,
      workspaceName: `${a.workspace.client}`,
      tools:         a.toolBindings.map((tb) => tb.tool.name),
      channels:      a.channelBindings.map((cb) => cb.binding.channel.displayName),
    }));

    res.json(result);
  } catch (e) { next(e); }
});

// GET /api/agents/:id
router.get("/:id", async (req, res, next) => {
  try {
    const agent = await prisma.agent.findUnique({
      where: { id: req.params.id },
      include: {
        promptTemplates: true,
        toolBindings: { include: { tool: true } },
      },
    });
    if (!agent) throw new AppError(404, "Agent not found");
    res.json(agent);
  } catch (e) { next(e); }
});

// POST /api/agents
router.post("/", async (req, res, next) => {
  try {
    const body = AgentSchema.safeParse(req.body);
    if (!body.success) throw new AppError(400, body.error.message);
    const agent = await prisma.agent.create({ data: body.data });
    res.status(201).json(agent);
  } catch (e) { next(e); }
});

// PATCH /api/agents/:id
router.patch("/:id", async (req, res, next) => {
  try {
    const body = AgentSchema.partial().safeParse(req.body);
    if (!body.success) throw new AppError(400, body.error.message);
    const agent = await prisma.agent.update({ where: { id: req.params.id }, data: body.data });
    res.json(agent);
  } catch (e) { next(e); }
});

// DELETE /api/agents/:id
router.delete("/:id", async (req, res, next) => {
  try {
    await prisma.agent.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (e) { next(e); }
});

// POST /api/agents/:id/tools  — bind tool to agent
router.post("/:id/tools", async (req, res, next) => {
  try {
    const { toolId } = z.object({ toolId: z.string().cuid() }).parse(req.body);
    await prisma.agentTool.upsert({
      where:  { agentId_toolId: { agentId: req.params.id, toolId } },
      update: {},
      create: { agentId: req.params.id, toolId },
    });
    res.status(201).json({ ok: true });
  } catch (e) { next(e); }
});

// DELETE /api/agents/:id/tools/:toolId
router.delete("/:id/tools/:toolId", async (req, res, next) => {
  try {
    await prisma.agentTool.delete({
      where: { agentId_toolId: { agentId: req.params.id, toolId: req.params.toolId } },
    });
    res.status(204).end();
  } catch (e) { next(e); }
});

export default router;
