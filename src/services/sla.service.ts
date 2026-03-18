// src/services/sla.service.ts
// SLA 監控：服務健康檢查、可用率計算、延遲追蹤
import { prisma } from "@/db/client";
import { HealthStatus } from "@prisma/client";

export interface ServiceCheckResult {
  service:    string;
  status:     HealthStatus;
  latencyMs:  number;
  error?:     string;
}

// ── 單項服務健康檢查 ──────────────────────────────────────────
async function checkService(
  name:    string,
  checkFn: () => Promise<void>
): Promise<ServiceCheckResult> {
  const start = Date.now();
  try {
    await checkFn();
    return { service: name, status: "HEALTHY", latencyMs: Date.now() - start };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const error     = (err as Error).message;
    const status: HealthStatus = latencyMs > 5000 ? "DEGRADED" : "DOWN";
    return { service: name, status, latencyMs, error };
  }
}

// ── 執行所有健康檢查 ──────────────────────────────────────────
export async function runHealthChecks(workspaceId?: string): Promise<ServiceCheckResult[]> {
  const results: ServiceCheckResult[] = [];

  // 1. Claude API
  const claudeKey = process.env.ANTHROPIC_API_KEY;
  results.push(await checkService("claude-api", async () => {
    if (!claudeKey) throw new Error("API key not configured");
    const r = await fetch("https://api.anthropic.com/v1/models", {
      headers: { "x-api-key": claudeKey, "anthropic-version": "2023-06-01" },
      signal:  AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  }));

  // 2. PostgreSQL (implicit — if we got here, DB is up)
  results.push(await checkService("database", async () => {
    await prisma.$queryRaw`SELECT 1`;
  }));

  // 3. Workspace-specific gateway
  if (workspaceId) {
    const ws = await prisma.workspace.findUnique({ where: { id: workspaceId } });
    if (ws) {
      results.push(await checkService("gateway", async () => {
        const r = await fetch(`${ws.gatewayUrl}/health`, { signal: AbortSignal.timeout(4000) });
        if (!r.ok) throw new Error(`Gateway HTTP ${r.status}`);
      }));
    }
  }

  // 4. LINE API reachability
  results.push(await checkService("line-api", async () => {
    const r = await fetch("https://api.line.me/v2/bot/info", {
      headers: { Authorization: "Bearer dummy" },
      signal:  AbortSignal.timeout(5000),
    });
    // 401 = reachable (auth failed as expected), anything else is a problem
    if (r.status !== 401 && !r.ok) throw new Error(`LINE API unreachable: HTTP ${r.status}`);
  }));

  // 5. Telegram API reachability
  results.push(await checkService("telegram-api", async () => {
    const r = await fetch("https://api.telegram.org/botDUMMY/getMe", { signal: AbortSignal.timeout(5000) });
    if (r.status !== 401 && r.status !== 200) throw new Error(`Telegram API: HTTP ${r.status}`);
  }));

  // Save all results to DB
  await prisma.serviceHealthCheck.createMany({
    data: results.map(r => ({
      workspaceId:  workspaceId ?? null,
      service:      r.service,
      status:       r.status,
      latencyMs:    r.latencyMs,
      errorMessage: r.error ?? null,
    })),
  });

  return results;
}

// ── 計算 SLA 指標（過去 N 天）────────────────────────────────
export async function calculateSLA(workspaceId: string, days = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const checks = await prisma.serviceHealthCheck.findMany({
    where:   { workspaceId, checkedAt: { gte: since } },
    orderBy: { checkedAt: "asc" },
  });

  if (!checks.length) return null;

  const total    = checks.length;
  const healthy  = checks.filter(c => c.status === "HEALTHY").length;
  const latencies= checks.filter(c => c.latencyMs !== null).map(c => c.latencyMs!).sort((a,b) => a-b);

  const uptimePct    = Math.round((healthy / total) * 10000) / 100;
  const avgLatency   = latencies.length ? Math.round(latencies.reduce((s,l) => s+l, 0) / latencies.length) : 0;
  const p95Index     = Math.floor(latencies.length * 0.95);
  const p95Latency   = latencies[p95Index] ?? 0;

  // Incident windows: consecutive non-HEALTHY periods
  const incidents: { start: Date; end: Date; duration: number; service: string }[] = [];
  let incidentStart: { at: Date; service: string } | null = null;

  for (const check of checks) {
    if (check.status !== "HEALTHY" && !incidentStart) {
      incidentStart = { at: check.checkedAt, service: check.service };
    } else if (check.status === "HEALTHY" && incidentStart) {
      incidents.push({
        start:    incidentStart.at,
        end:      check.checkedAt,
        duration: Math.round((check.checkedAt.getTime() - incidentStart.at.getTime()) / 60000),
        service:  incidentStart.service,
      });
      incidentStart = null;
    }
  }

  return {
    period:      { days, since },
    uptimePct,
    avgLatencyMs:avgLatency,
    p95LatencyMs:p95Latency,
    totalChecks: total,
    incidents,
    slaGrade:    uptimePct >= 99.9 ? "A" : uptimePct >= 99 ? "B" : uptimePct >= 95 ? "C" : "D",
  };
}
