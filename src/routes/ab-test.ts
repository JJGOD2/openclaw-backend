// src/routes/ab-test.ts
import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/db/client";
import { requireAuth } from "@/middleware/auth";
import { AppError } from "@/middleware/errorHandler";
import { ABTestStatus } from "@prisma/client";

const router = Router();
router.use(requireAuth);

// ── GET /api/ab-tests?workspaceId= ───────────────────────────
router.get("/", async (req, res, next) => {
  try {
    const { workspaceId } = z.object({ workspaceId: z.string().cuid() }).parse(req.query);
    const tests = await prisma.aBTest.findMany({
      where:   { workspaceId },
      include: {
        variants: true,
        _count:   { select: { results: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    res.json(tests);
  } catch (e) { next(e); }
});

// ── POST /api/ab-tests ───────────────────────────────────────
router.post("/", async (req, res, next) => {
  try {
    const body = z.object({
      workspaceId:  z.string().cuid(),
      name:         z.string().min(1).max(100),
      agentId:      z.string().cuid(),
      trafficSplit: z.number().min(10).max(90).default(50),
      variantA:     z.object({ systemPrompt:z.string().min(1), modelId:z.string().optional(), description:z.string().optional() }),
      variantB:     z.object({ systemPrompt:z.string().min(1), modelId:z.string().optional(), description:z.string().optional() }),
    }).parse(req.body);

    const test = await prisma.$transaction(async tx => {
      const t = await tx.aBTest.create({
        data: { workspaceId:body.workspaceId, name:body.name, agentId:body.agentId,
                trafficSplit:body.trafficSplit, status:"DRAFT" },
      });
      await tx.aBVariant.createMany({
        data:[
          { testId:t.id, label:"A", systemPrompt:body.variantA.systemPrompt,
            modelId:body.variantA.modelId, description:body.variantA.description },
          { testId:t.id, label:"B", systemPrompt:body.variantB.systemPrompt,
            modelId:body.variantB.modelId, description:body.variantB.description },
        ],
      });
      return t;
    });
    res.status(201).json(test);
  } catch (e) { next(e); }
});

// ── PATCH /api/ab-tests/:id/status ───────────────────────────
router.patch("/:id/status", async (req, res, next) => {
  try {
    const { status } = z.object({ status: z.nativeEnum(ABTestStatus) }).parse(req.body);
    const test = await prisma.aBTest.update({
      where: { id: req.params.id },
      data: {
        status,
        ...(status==="RUNNING"   ? { startedAt:new Date() } : {}),
        ...(status==="COMPLETED" ? { endedAt:  new Date() } : {}),
      },
    });
    res.json(test);
  } catch (e) { next(e); }
});

// ── GET /api/ab-tests/:id/results ────────────────────────────
router.get("/:id/results", async (req, res, next) => {
  try {
    const test = await prisma.aBTest.findUnique({
      where:   { id: req.params.id },
      include: { variants: true },
    });
    if (!test) throw new AppError(404, "Test not found");

    const stats = await Promise.all(test.variants.map(async v => {
      const results = await prisma.aBResult.findMany({ where: { variantId: v.id } });
      const n          = results.length;
      const resolved   = results.filter(r => r.resolved).length;
      const handoffs   = results.filter(r => r.handedOff).length;
      const avgTurns   = n ? results.reduce((s,r)=>s+r.turnCount,0)/n : 0;
      const avgRT      = results.filter(r=>r.responseTime).length
        ? results.filter(r=>r.responseTime).reduce((s,r)=>s+(r.responseTime!),0) /
          results.filter(r=>r.responseTime).length : 0;
      const avgRating  = results.filter(r=>r.rating).length
        ? results.filter(r=>r.rating).reduce((s,r)=>s+(r.rating!),0) /
          results.filter(r=>r.rating).length : null;

      return {
        variant:       v,
        n,
        resolvedRate:  n ? Math.round(resolved/n*1000)/10 : 0,
        handoffRate:   n ? Math.round(handoffs/n*1000)/10 : 0,
        avgTurns:      Math.round(avgTurns*10)/10,
        avgResponseMs: Math.round(avgRT),
        avgRating,
      };
    }));

    // Determine winner (higher resolution rate)
    let winner: string|null = null;
    if (stats[0].n >= 30 && stats[1].n >= 30) {
      winner = stats[0].resolvedRate >= stats[1].resolvedRate ? "A" : "B";
    }

    res.json({ test, variants: stats, winner,
      sampleSize: stats.reduce((s,v)=>s+v.n, 0) });
  } catch (e) { next(e); }
});

// ── POST /api/ab-tests/:id/record ─────────────────────────────
// Record a result (called after each conversation ends)
router.post("/:id/record", async (req, res, next) => {
  try {
    const body = z.object({
      variantLabel: z.enum(["A","B"]),
      userId:       z.string(),
      sessionId:    z.string().optional(),
      resolved:     z.boolean().optional(),
      handedOff:    z.boolean().optional(),
      turnCount:    z.number().optional(),
      responseTime: z.number().optional(),
      rating:       z.number().min(1).max(5).optional(),
    }).parse(req.body);

    const variant = await prisma.aBVariant.findFirst({
      where: { testId:req.params.id, label:body.variantLabel },
    });
    if (!variant) throw new AppError(404, "Variant not found");

    const result = await prisma.aBResult.create({
      data: { testId:req.params.id, variantId:variant.id,
              userId:body.userId, sessionId:body.sessionId,
              resolved:body.resolved??false, handedOff:body.handedOff??false,
              turnCount:body.turnCount??0, responseTime:body.responseTime,
              rating:body.rating },
    });
    res.status(201).json(result);
  } catch (e) { next(e); }
});

// ── GET /api/ab-tests/:agentId/active ────────────────────────
// Get active test for an agent + determine variant for a user
router.get("/agent/:agentId/active", async (req, res, next) => {
  try {
    const { userId } = z.object({ userId: z.string() }).parse(req.query);
    const test = await prisma.aBTest.findFirst({
      where:   { agentId: req.params.agentId, status: "RUNNING" },
      include: { variants: true },
    });
    if (!test) return res.json({ active: false });

    // Deterministic assignment: hash userId to always get same variant
    const hash = userId.split("").reduce((acc,c) => acc + c.charCodeAt(0), 0);
    const label = (hash % 100) < test.trafficSplit ? "B" : "A";
    const variant = test.variants.find(v => v.label === label)!;

    res.json({ active: true, testId: test.id, label, variant });
  } catch (e) { next(e); }
});

export default router;
