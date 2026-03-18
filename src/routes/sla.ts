// src/routes/sla.ts
import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/db/client";
import { requireAuth } from "@/middleware/auth";
import { runHealthChecks, calculateSLA } from "@/services/sla.service";

const router = Router();
router.use(requireAuth);

// GET /api/sla/health?workspaceId=
router.get("/health", async (req, res, next) => {
  try {
    const { workspaceId } = z.object({ workspaceId: z.string().cuid().optional() }).parse(req.query);

    // Latest check per service
    const services = ["claude-api","database","gateway","line-api","telegram-api"];
    const latest   = await Promise.all(services.map(async (service) => {
      const check = await prisma.serviceHealthCheck.findFirst({
        where:   { service, ...(workspaceId ? { workspaceId } : {}) },
        orderBy: { checkedAt: "desc" },
      });
      return { service, ...check ?? { status: "UNKNOWN", latencyMs: null, errorMessage: null, checkedAt: null } };
    }));

    const overallStatus = latest.every(s => s.status === "HEALTHY") ? "HEALTHY"
      : latest.some(s => s.status === "DOWN") ? "DOWN" : "DEGRADED";

    res.json({ overallStatus, services: latest });
  } catch (e) { next(e); }
});

// POST /api/sla/check?workspaceId= (trigger a manual health check)
router.post("/check", async (req, res, next) => {
  try {
    const { workspaceId } = z.object({ workspaceId: z.string().cuid().optional() }).parse(req.query);
    const results = await runHealthChecks(workspaceId);
    res.json(results);
  } catch (e) { next(e); }
});

// GET /api/sla/report?workspaceId=&days=
router.get("/report", async (req, res, next) => {
  try {
    const { workspaceId, days } = z.object({
      workspaceId: z.string().cuid(),
      days:        z.coerce.number().default(30),
    }).parse(req.query);

    const report = await calculateSLA(workspaceId, days);
    res.json(report ?? { error: "Not enough data yet" });
  } catch (e) { next(e); }
});

// GET /api/sla/history?workspaceId=&service=&hours=24
router.get("/history", async (req, res, next) => {
  try {
    const { workspaceId, service, hours } = z.object({
      workspaceId: z.string().cuid().optional(),
      service:     z.string().optional(),
      hours:       z.coerce.number().default(24),
    }).parse(req.query);

    const since = new Date(Date.now() - hours * 3600_000);
    const checks = await prisma.serviceHealthCheck.findMany({
      where:   {
        ...(workspaceId ? { workspaceId } : {}),
        ...(service     ? { service }     : {}),
        checkedAt: { gte: since },
      },
      orderBy: { checkedAt: "asc" },
      take:    500,
    });
    res.json(checks);
  } catch (e) { next(e); }
});

export default router;
