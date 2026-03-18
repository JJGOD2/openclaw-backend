// src/routes/chains.ts
import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/db/client";
import { requireAuth } from "@/middleware/auth";
import { AppError } from "@/middleware/errorHandler";
import { runChain } from "@/services/chain.service";

const router = Router();
router.use(requireAuth);

// GET /api/chains?workspaceId=
router.get("/", async (req, res, next) => {
  try {
    const { workspaceId } = z.object({ workspaceId: z.string().cuid() }).parse(req.query);
    const chains = await prisma.agentChain.findMany({
      where:   { workspaceId },
      include: { _count: { select: { runs: true } } },
      orderBy: { createdAt: "desc" },
    });
    res.json(chains);
  } catch (e) { next(e); }
});

// POST /api/chains
router.post("/", async (req, res, next) => {
  try {
    const body = z.object({
      workspaceId: z.string().cuid(),
      name:        z.string().min(1).max(100),
      description: z.string().optional(),
      stepsJson:   z.array(z.record(z.unknown())).min(1),
      enabled:     z.boolean().default(true),
    }).parse(req.body);
    const chain = await prisma.agentChain.create({ data: body });
    res.status(201).json(chain);
  } catch (e) { next(e); }
});

// GET /api/chains/:id
router.get("/:id", async (req, res, next) => {
  try {
    const chain = await prisma.agentChain.findUnique({
      where:   { id: req.params.id },
      include: { _count: { select: { runs: true } } },
    });
    if (!chain) throw new AppError(404, "Chain not found");
    res.json(chain);
  } catch (e) { next(e); }
});

// PATCH /api/chains/:id
router.patch("/:id", async (req, res, next) => {
  try {
    const body = z.object({
      name:        z.string().optional(),
      description: z.string().optional(),
      stepsJson:   z.array(z.record(z.unknown())).optional(),
      enabled:     z.boolean().optional(),
    }).parse(req.body);
    const chain = await prisma.agentChain.update({ where: { id: req.params.id }, data: body });
    res.json(chain);
  } catch (e) { next(e); }
});

// DELETE /api/chains/:id
router.delete("/:id", async (req, res, next) => {
  try {
    await prisma.agentChain.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (e) { next(e); }
});

// POST /api/chains/:id/run — execute chain
router.post("/:id/run", async (req, res, next) => {
  try {
    const body = z.object({
      workspaceId: z.string().cuid(),
      input:       z.string().min(1),
      userId:      z.string().default("test-user"),
      platform:    z.string().default("PLAYGROUND"),
      vars:        z.record(z.string()).default({}),
    }).parse(req.body);

    const result = await runChain(req.params.id, body.input, {
      workspaceId: body.workspaceId,
      userId:      body.userId,
      platform:    body.platform,
      vars:        body.vars,
    });
    res.json(result);
  } catch (e) { next(e); }
});

// GET /api/chains/:id/runs
router.get("/:id/runs", async (req, res, next) => {
  try {
    const runs = await prisma.chainRun.findMany({
      where:   { chainId: req.params.id },
      orderBy: { startedAt: "desc" },
      take:    50,
      select:  { id:true, userId:true, platform:true, status:true,
                 input:true, output:true, errorMsg:true,
                 startedAt:true, completedAt:true },
    });
    res.json(runs);
  } catch (e) { next(e); }
});

export default router;
