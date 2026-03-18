// src/routes/security.ts
import { Router } from "express";
import { prisma } from "@/db/client";
import { requireAuth } from "@/middleware/auth";
import { AuditResult } from "@prisma/client";

const router = Router();
router.use(requireAuth);

// GET /api/security/audit?workspaceId=xxx
router.get("/audit", async (req, res, next) => {
  try {
    const { workspaceId } = req.query;
    const items = await prisma.securityAudit.findMany({
      where: workspaceId ? { OR: [{ workspaceId: String(workspaceId) }, { workspaceId: null }] } : {},
      orderBy: [{ result: "asc" }, { createdAt: "desc" }],
    });

    const score = calcScore(items.map((i) => i.result));
    res.json({ score, items });
  } catch (e) { next(e); }
});

// POST /api/security/audit/:id/resolve
router.post("/audit/:id/resolve", async (req, res, next) => {
  try {
    const item = await prisma.securityAudit.update({
      where: { id: req.params.id },
      data:  { resolvedAt: new Date() },
    });
    res.json(item);
  } catch (e) { next(e); }
});

function calcScore(results: AuditResult[]): number {
  if (results.length === 0) return 100;
  const weights = { PASS: 0, WARN: 10, FAIL: 30 };
  const total = results.reduce((acc, r) => acc + weights[r], 0);
  const max   = results.length * 30;
  return Math.max(0, Math.round(100 - (total / max) * 100));
}

export default router;
