// src/routes/flows.ts
import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/db/client";
import { requireAuth } from "@/middleware/auth";
import { AppError } from "@/middleware/errorHandler";
import { runFlow } from "@/services/flow.service";
import { FlowStatus } from "@prisma/client";

const router = Router();
router.use(requireAuth);

// GET /api/flows?workspaceId=
router.get("/", async (req, res, next) => {
  try {
    const { workspaceId } = z.object({ workspaceId: z.string().cuid() }).parse(req.query);
    const flows = await prisma.conversationFlow.findMany({
      where:   { workspaceId },
      select:  { id:true, name:true, description:true, trigger:true,
                 triggerValue:true, status:true, stats:true, createdAt:true,
                 _count:{ select:{ runs:true } } },
      orderBy: { updatedAt: "desc" },
    });
    res.json(flows);
  } catch (e) { next(e); }
});

// POST /api/flows
router.post("/", async (req, res, next) => {
  try {
    const body = z.object({
      workspaceId:  z.string().cuid(),
      name:         z.string().min(1).max(100),
      description:  z.string().optional(),
      trigger:      z.string().default("manual"),
      triggerValue: z.string().optional(),
      nodesJson:    z.array(z.record(z.unknown())).default([]),
      edgesJson:    z.array(z.record(z.unknown())).default([]),
    }).parse(req.body);
    const flow = await prisma.conversationFlow.create({ data: body });
    res.status(201).json(flow);
  } catch (e) { next(e); }
});

// GET /api/flows/:id
router.get("/:id", async (req, res, next) => {
  try {
    const flow = await prisma.conversationFlow.findUnique({ where: { id: req.params.id } });
    if (!flow) throw new AppError(404, "Flow not found");
    res.json(flow);
  } catch (e) { next(e); }
});

// PATCH /api/flows/:id
router.patch("/:id", async (req, res, next) => {
  try {
    const body = z.object({
      name:         z.string().optional(),
      description:  z.string().optional(),
      trigger:      z.string().optional(),
      triggerValue: z.string().optional(),
      nodesJson:    z.array(z.record(z.unknown())).optional(),
      edgesJson:    z.array(z.record(z.unknown())).optional(),
      status:       z.nativeEnum(FlowStatus).optional(),
    }).parse(req.body);
    const flow = await prisma.conversationFlow.update({ where: { id: req.params.id }, data: body });
    res.json(flow);
  } catch (e) { next(e); }
});

// DELETE /api/flows/:id
router.delete("/:id", async (req, res, next) => {
  try {
    await prisma.conversationFlow.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (e) { next(e); }
});

// POST /api/flows/:id/run — execute flow (test or webhook trigger)
router.post("/:id/run", async (req, res, next) => {
  try {
    const body = z.object({
      workspaceId: z.string().cuid(),
      userId:      z.string().default("test-user"),
      platform:    z.string().default("PLAYGROUND"),
      message:     z.string().default(""),
      vars:        z.record(z.unknown()).default({}),
      runId:       z.string().optional(),
    }).parse(req.body);

    const result = await runFlow(
      req.params.id,
      { userId: body.userId, platform: body.platform,
        workspaceId: body.workspaceId, vars: body.vars,
        lastMessage: body.message },
      body.runId
    );
    res.json(result);
  } catch (e) { next(e); }
});

// GET /api/flows/:id/runs — list runs for a flow
router.get("/:id/runs", async (req, res, next) => {
  try {
    const runs = await prisma.flowRun.findMany({
      where:   { flowId: req.params.id },
      orderBy: { startedAt: "desc" },
      take:    50,
    });
    const total      = await prisma.flowRun.count({ where: { flowId: req.params.id } });
    const completed  = await prisma.flowRun.count({ where: { flowId: req.params.id, completed: true } });
    res.json({ runs, total, completed, completionRate: total ? Math.round(completed/total*100) : 0 });
  } catch (e) { next(e); }
});

export default router;
