// src/routes/orchestration.ts
import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/db/client";
import { requireAuth } from "@/middleware/auth";
import { AppError } from "@/middleware/errorHandler";
import { executeFlow } from "@/services/orchestration/engine";

const router = Router();
router.use(requireAuth);

// GET /api/orchestration?workspaceId=
router.get("/", async (req, res, next) => {
  try {
    const { workspaceId } = z.object({ workspaceId: z.string().cuid() }).parse(req.query);
    const flows = await prisma.orchestrationFlow.findMany({
      where:   { workspaceId },
      include: { _count: { select: { runs: true } } },
      orderBy: { createdAt: "desc" },
    });
    res.json(flows);
  } catch (e) { next(e); }
});

// POST /api/orchestration
router.post("/", async (req, res, next) => {
  try {
    const body = z.object({
      workspaceId:     z.string().cuid(),
      name:            z.string().min(1).max(100),
      description:     z.string().max(400).optional(),
      triggerAgentId:  z.string().cuid(),
      stepsJson:       z.array(z.record(z.unknown())).min(1),
    }).parse(req.body);

    const flow = await prisma.orchestrationFlow.create({ data: body });
    res.status(201).json(flow);
  } catch (e) { next(e); }
});

// PATCH /api/orchestration/:id
router.patch("/:id", async (req, res, next) => {
  try {
    const body = z.object({
      name:        z.string().optional(),
      description: z.string().optional(),
      stepsJson:   z.array(z.record(z.unknown())).optional(),
      enabled:     z.boolean().optional(),
    }).parse(req.body);
    const flow = await prisma.orchestrationFlow.update({ where:{id:req.params.id}, data:body });
    res.json(flow);
  } catch (e) { next(e); }
});

// DELETE /api/orchestration/:id
router.delete("/:id", async (req, res, next) => {
  try {
    await prisma.orchestrationFlow.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (e) { next(e); }
});

// POST /api/orchestration/:id/run
router.post("/:id/run", async (req, res, next) => {
  try {
    const { userId, inputText, platform, sessionId } = z.object({
      userId:    z.string().min(1),
      inputText: z.string().min(1).max(4000),
      platform:  z.string().default("PLAYGROUND"),
      sessionId: z.string().optional(),
    }).parse(req.body);

    const flow = await prisma.orchestrationFlow.findUnique({ where: { id: req.params.id } });
    if (!flow) throw new AppError(404, "Flow not found");
    if (!flow.enabled) throw new AppError(400, "Flow is disabled");

    const result = await executeFlow({
      flowId: req.params.id, userId, inputText, platform, sessionId,
    });
    res.json(result);
  } catch (e) { next(e); }
});

// GET /api/orchestration/:id/runs
router.get("/:id/runs", async (req, res, next) => {
  try {
    const runs = await prisma.orchRun.findMany({
      where:   { flowId: req.params.id },
      orderBy: { startedAt: "desc" },
      take:    20,
    });
    res.json(runs);
  } catch (e) { next(e); }
});

export default router;
