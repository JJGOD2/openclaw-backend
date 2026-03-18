// src/routes/security-tools.ts
// 安全工具：Prompt Guard 測試 + Circuit Breaker 狀態管理
import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireAdmin } from "@/middleware/auth";
import { scanInput, PATTERNS } from "@/services/security/prompt-guard.service";
import { getCircuitStates, resetCircuit } from "@/lib/circuit-breaker";

const router = Router();
router.use(requireAuth);

// POST /api/security/guard-test — test input against prompt guard
router.post("/guard-test", async (req, res, next) => {
  try {
    const { text } = z.object({ text: z.string().min(1).max(5000) }).parse(req.body);
    const result   = scanInput(text);

    // Enrich with pattern details
    const matchedPatterns = PATTERNS.filter(p => result.triggers.includes(p.id))
      .map(p => ({ id: p.id, name: p.name, risk: p.risk, action: p.action }));

    res.json({ ...result, matchedPatterns });
  } catch (e) { next(e); }
});

// GET /api/security/guard-patterns — list all patterns
router.get("/guard-patterns", (_req, res) => {
  res.json(PATTERNS.map(p => ({
    id:     p.id,
    name:   p.name,
    risk:   p.risk,
    action: p.action,
  })));
});

// GET /api/security/circuits — circuit breaker status
router.get("/circuits", (_req, res) => {
  const states = getCircuitStates();
  const summary = Object.entries(states).map(([name, s]) => ({
    name,
    state:       s.state,
    failures:    s.failures,
    nextAttempt: s.nextAttempt,
    healthy:     s.state === "CLOSED",
  }));
  res.json({
    circuits:    summary,
    allHealthy:  summary.every(s => s.healthy),
    openCount:   summary.filter(s => s.state === "OPEN").length,
  });
});

// POST /api/security/circuits/:name/reset — force reset a circuit
router.post("/circuits/:name/reset", requireAdmin, (req, res) => {
  const reset = resetCircuit(req.params.name);
  if (!reset) {
    return res.status(404).json({ error: "Circuit not found" });
  }
  res.json({ ok: true, circuit: req.params.name, state: "CLOSED" });
});

export default router;
