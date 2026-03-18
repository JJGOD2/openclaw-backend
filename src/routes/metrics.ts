// src/routes/metrics.ts
// Prometheus 格式 metrics 端點（/metrics）
// 相容 Grafana Agent、Prometheus、Victoria Metrics
import { Router } from "express";
import { prisma } from "@/db/client";
import { getCircuitStates } from "@/lib/circuit-breaker";
import { getCacheStats } from "@/lib/cache/redis";

const router = Router();

// GET /metrics — Prometheus text format (no auth for scraper compatibility)
// 建議用 IP allowlist / internal network 保護此端點
router.get("/", async (_req, res, next) => {
  try {
    const now = Date.now();

    // Gather metrics from DB
    const [
      workspaceCount, agentCount, activeSessionCount,
      pendingReviews, pendingHandoffs,
      last1hMessages, last1hErrors,
    ] = await Promise.all([
      prisma.workspace.count(),
      prisma.agent.count(),
      prisma.conversationSession.count({ where: { isActive: true } }),
      prisma.reviewQueue.count({ where: { status: "PENDING" } }),
      prisma.handoffQueue.count({ where: { status: "PENDING" } }),
      prisma.logEntry.count({ where: { createdAt: { gte: new Date(now - 3600_000) } } }),
      prisma.logEntry.count({ where: { type: "ERROR", createdAt: { gte: new Date(now - 3600_000) } } }),
    ]);

    // Per-plan workspace counts
    const planCounts = await prisma.workspace.groupBy({
      by: ["plan"], _count: true,
    });
    const planMap = Object.fromEntries(planCounts.map(p => [p.plan.toLowerCase(), p._count]));

    // Circuit breaker states (1=CLOSED, 2=HALF_OPEN, 3=OPEN)
    const circuits   = getCircuitStates();
    const circuitNums = { CLOSED:1, HALF_OPEN:2, OPEN:3 };
    const cacheStats = getCacheStats();

    // Format as Prometheus exposition text
    const lines: string[] = [
      "# HELP openclaw_workspaces_total Total number of workspaces",
      "# TYPE openclaw_workspaces_total gauge",
      `openclaw_workspaces_total ${workspaceCount}`,
      "",
      "# HELP openclaw_agents_total Total number of agents",
      "# TYPE openclaw_agents_total gauge",
      `openclaw_agents_total ${agentCount}`,
      "",
      "# HELP openclaw_active_sessions Active conversation sessions",
      "# TYPE openclaw_active_sessions gauge",
      `openclaw_active_sessions ${activeSessionCount}`,
      "",
      "# HELP openclaw_pending_reviews Items in review queue",
      "# TYPE openclaw_pending_reviews gauge",
      `openclaw_pending_reviews ${pendingReviews}`,
      "",
      "# HELP openclaw_pending_handoffs Items in handoff queue",
      "# TYPE openclaw_pending_handoffs gauge",
      `openclaw_pending_handoffs ${pendingHandoffs}`,
      "",
      "# HELP openclaw_log_entries_1h Log entries in last hour",
      "# TYPE openclaw_log_entries_1h gauge",
      `openclaw_log_entries_1h{type="all"} ${last1hMessages}`,
      `openclaw_log_entries_1h{type="error"} ${last1hErrors}`,
      "",
      "# HELP openclaw_error_rate_1h Error rate in last hour (0-1)",
      "# TYPE openclaw_error_rate_1h gauge",
      `openclaw_error_rate_1h ${last1hMessages > 0 ? (last1hErrors / last1hMessages).toFixed(4) : 0}`,
      "",
      "# HELP openclaw_workspaces_by_plan Workspaces grouped by plan",
      "# TYPE openclaw_workspaces_by_plan gauge",
      ...["starter","pro","business"].map(p =>
        `openclaw_workspaces_by_plan{plan="${p}"} ${planMap[p] ?? 0}`
      ),
      "",
      "# HELP openclaw_circuit_state Circuit breaker state (1=CLOSED 2=HALF_OPEN 3=OPEN)",
      "# TYPE openclaw_circuit_state gauge",
      ...Object.entries(circuits).map(([name, s]) =>
        `openclaw_circuit_state{circuit="${name}"} ${circuitNums[s.state]}`
      ),
      "",
      "# HELP openclaw_circuit_failures Circuit breaker failure count",
      "# TYPE openclaw_circuit_failures gauge",
      ...Object.entries(circuits).map(([name, s]) =>
        `openclaw_circuit_failures{circuit="${name}"} ${s.failures}`
      ),
      "",
      "# HELP openclaw_cache_backend Cache backend (1=redis 0=memory)",
      "# TYPE openclaw_cache_backend gauge",
      `openclaw_cache_backend ${cacheStats.backend === "redis" ? 1 : 0}`,
      `openclaw_cache_memory_keys ${cacheStats.memKeys}`,
      "",
      `# Scraped at ${new Date().toISOString()}`,
    ];

    res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    res.send(lines.join("\n"));
  } catch (e) { next(e); }
});

export default router;
