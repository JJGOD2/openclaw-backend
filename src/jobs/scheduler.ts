// src/jobs/scheduler.ts
// 定時任務排程器（不依賴外部套件，使用 Node.js setInterval）
// 生產環境建議改用 node-cron 或 BullMQ
import { prisma } from "@/db/client";
import { dispatch } from "@/routes/alerts";
import { AlertTrigger, AlertChannel } from "@prisma/client";

// ── Utility ──────────────────────────────────────────────────
function log(msg: string) {
  console.log(`[Scheduler ${new Date().toISOString()}] ${msg}`);
}

// ── Job: 每日用量報告 (09:00 每天) ───────────────────────────
async function dailyUsageReport() {
  log("Running: dailyUsageReport");
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const records = await prisma.usageRecord.findMany({
      where: { date: today },
      include: { workspace: { select: { client: true, name: true } } },
    });

    if (!records.length) return;

    const totalCost   = records.reduce((s, r) => s + Number(r.costNTD), 0);
    const totalTokens = records.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0);
    const totalMsgs   = records.reduce((s, r) => s + r.messages, 0);

    const lines = records.map((r) =>
      `  • ${r.workspace.client} — ${r.workspace.name}: ${r.messages} 則 / NT$${Number(r.costNTD).toFixed(0)}`
    ).join("\n");

    const message = `📊 MyWrapper 每日用量報告 (${today.toLocaleDateString("zh-TW")})\n\n` +
      `總訊息：${totalMsgs.toLocaleString()} 則\n` +
      `總 Token：${(totalTokens / 1000).toFixed(1)}k\n` +
      `總費用：NT$${totalCost.toFixed(0)}\n\n` +
      `各 Workspace：\n${lines}`;

    // Fire all DAILY_REPORT alert rules
    const rules = await prisma.alertRule.findMany({
      where: { trigger: "DAILY_REPORT", enabled: true },
    });
    for (const rule of rules) {
      await dispatch(rule.channel as AlertChannel, rule.destination, {
        title:   "每日用量報告",
        message,
      });
      await prisma.alertRule.update({
        where: { id: rule.id },
        data:  { lastFiredAt: new Date() },
      });
    }

    log(`dailyUsageReport: fired ${rules.length} rules`);
  } catch (err) {
    log(`dailyUsageReport ERROR: ${(err as Error).message}`);
  }
}

// ── Job: 預算超標檢查 (每小時) ───────────────────────────────
async function budgetThresholdCheck() {
  log("Running: budgetThresholdCheck");
  try {
    const rules = await prisma.alertRule.findMany({
      where: { trigger: "BUDGET_THRESHOLD", enabled: true },
    });

    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    for (const rule of rules) {
      if (!rule.threshold) continue;

      const where = rule.workspaceId
        ? { workspaceId: rule.workspaceId, date: { gte: startOfMonth } }
        : { date: { gte: startOfMonth } };

      const agg = await prisma.usageRecord.aggregate({
        where,
        _sum: { costNTD: true },
      });

      const totalCost = Number(agg._sum.costNTD ?? 0);
      if (totalCost >= rule.threshold) {
        // Avoid spamming: only fire once per day
        const firedToday = rule.lastFiredAt &&
          rule.lastFiredAt.toDateString() === new Date().toDateString();
        if (firedToday) continue;

        await dispatch(rule.channel as AlertChannel, rule.destination, {
          title:   "⚠ 預算超標告警",
          message: `本月累計費用 NT$${totalCost.toFixed(0)} 已超過閾值 NT$${rule.threshold}`,
        });
        await prisma.alertRule.update({
          where: { id: rule.id },
          data:  { lastFiredAt: new Date() },
        });
      }
    }
  } catch (err) {
    log(`budgetThresholdCheck ERROR: ${(err as Error).message}`);
  }
}

// ── Job: Secret 過期提醒 (每天) ──────────────────────────────
async function secretExpiryCheck() {
  log("Running: secretExpiryCheck");
  try {
    const soon = new Date();
    soon.setDate(soon.getDate() + 30);

    const expiring = await prisma.secret.findMany({
      where: {
        expiresAt: { lte: soon, gte: new Date() },
        status:    { not: "EXPIRED" },
      },
      include: { workspace: { select: { client: true, name: true } } },
    });

    for (const s of expiring) {
      // Update status
      const daysLeft = Math.ceil(
        ((s.expiresAt as Date).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
      );
      await prisma.secret.update({
        where: { id: s.id },
        data:  { status: daysLeft <= 0 ? "EXPIRED" : "EXPIRING" },
      });

      // Log warning
      await prisma.logEntry.create({
        data: {
          workspaceId: s.workspaceId,
          type:        "WARN",
          message:     `[Secret] ${s.name} 將於 ${daysLeft} 天後到期（${s.workspace.client}）`,
        },
      });
    }

    if (expiring.length > 0) {
      log(`secretExpiryCheck: ${expiring.length} secrets expiring soon`);
    }
  } catch (err) {
    log(`secretExpiryCheck ERROR: ${(err as Error).message}`);
  }
}

// ── Job: 審核逾時處理 (每15分鐘) ────────────────────────────
async function reviewTimeoutCheck() {
  try {
    const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours
    const result = await prisma.reviewQueue.updateMany({
      where:  { status: "PENDING", createdAt: { lt: cutoff } },
      data:   { status: "TIMEOUT" },
    });
    if (result.count > 0) {
      log(`reviewTimeoutCheck: ${result.count} items timed out`);
    }

    // Fire REVIEW_PENDING alerts if there are pending items
    const pendingCount = await prisma.reviewQueue.count({ where: { status: "PENDING" } });
    if (pendingCount > 0) {
      const rules = await prisma.alertRule.findMany({
        where: { trigger: "REVIEW_PENDING", enabled: true },
      });
      for (const rule of rules) {
        const lastFired = rule.lastFiredAt;
        const firedRecently = lastFired &&
          (Date.now() - lastFired.getTime()) < 15 * 60 * 1000;
        if (firedRecently) continue;

        await dispatch(rule.channel as AlertChannel, rule.destination, {
          title:   "📋 有待審核項目",
          message: `目前有 ${pendingCount} 筆訊息等待人工審核，請盡快處理。`,
        });
        await prisma.alertRule.update({
          where: { id: rule.id },
          data:  { lastFiredAt: new Date() },
        });
      }
    }
  } catch (err) {
    log(`reviewTimeoutCheck ERROR: ${(err as Error).message}`);
  }
}

// ── Job: Tool 失敗率檢查 (每5分鐘) ──────────────────────────
async function errorRateCheck() {
  try {
    const since = new Date(Date.now() - 60 * 60 * 1000); // last 1 hour
    const total  = await prisma.logEntry.count({ where: { type: "TOOL",  createdAt: { gte: since } } });
    const errors = await prisma.logEntry.count({ where: { type: "ERROR", createdAt: { gte: since } } });

    if (total === 0) return;
    const errorRate = (errors / total) * 100;

    const rules = await prisma.alertRule.findMany({
      where: { trigger: "ERROR_RATE_HIGH", enabled: true },
    });
    for (const rule of rules) {
      if (!rule.threshold || errorRate < rule.threshold) continue;
      const firedRecently = rule.lastFiredAt &&
        (Date.now() - rule.lastFiredAt.getTime()) < 30 * 60 * 1000;
      if (firedRecently) continue;

      await dispatch(rule.channel as AlertChannel, rule.destination, {
        title:   "⚠ Tool 失敗率過高",
        message: `過去 1 小時 Tool 失敗率 ${errorRate.toFixed(1)}%（閾值 ${rule.threshold}%）`,
      });
      await prisma.alertRule.update({
        where: { id: rule.id },
        data:  { lastFiredAt: new Date() },
      });
    }
  } catch (err) {
    log(`errorRateCheck ERROR: ${(err as Error).message}`);
  }
}

// ── Scheduler bootstrap ──────────────────────────────────────
export function startScheduler() {
  log("Scheduler started");

  // Daily report at 09:00 — check every minute
  setInterval(async () => {
    const now = new Date();
    if (now.getHours() === 9 && now.getMinutes() === 0) {
      await dailyUsageReport();
      await secretExpiryCheck();
    }
  }, 60_000);

  // Budget check every hour
  setInterval(budgetThresholdCheck, 60 * 60_000);

  // Review timeout every 15 minutes
  setInterval(reviewTimeoutCheck, 15 * 60_000);

  // Error rate every 5 minutes
  setInterval(errorRateCheck, 5 * 60_000);

  // Run immediately on startup
  setTimeout(async () => {
    await reviewTimeoutCheck();
    await budgetThresholdCheck();
  }, 5000);
}

// ── Job: OAuth Token 預先換票（每 30 分鐘）──────────────────
async function proactiveTokenRefresh() {
  try {
    const soon = new Date(Date.now() + 10 * 60 * 1000);   // 10 分鐘內到期

    const expiringSoon = await prisma.oAuthToken.findMany({
      where: {
        isValid:              true,
        expiresAt:            { lte: soon },
        encryptedRefreshToken:{ not: null },
      },
    });

    for (const token of expiringSoon) {
      try {
        const { getValidAccessToken } = await import("@/services/oauth/token.service");
        await getValidAccessToken(token.workspaceId, token.provider, token.scope);
        log(`proactiveTokenRefresh: refreshed ${token.provider} for workspace ${token.workspaceId}`);
      } catch (err) {
        log(`proactiveTokenRefresh WARN: ${token.provider} workspace ${token.workspaceId}: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    log(`proactiveTokenRefresh ERROR: ${(err as Error).message}`);
  }
}

// Register in scheduler — add to startScheduler() export
const _origStart = startScheduler;
// Patch the existing scheduler to also run token refresh
setInterval(proactiveTokenRefresh, 30 * 60_000);
setTimeout(proactiveTokenRefresh, 10_000);   // run shortly after boot

// ── Job: Webhook DLQ Retry（每 5 分鐘）──────────────────────
async function webhookDLQRetry() {
  try {
    const { processDLQ } = await import("@/services/webhook-retry.service");
    const result = await processDLQ();
    if (result.processed > 0) {
      log(`webhookDLQRetry: processed=${result.processed} resolved=${result.resolved} dead=${result.dead}`);
    }
  } catch (err) {
    log(`webhookDLQRetry ERROR: ${(err as Error).message}`);
  }
}
setInterval(webhookDLQRetry, 5 * 60_000);

// ── Job: SLA 健康檢查（每 10 分鐘）─────────────────────────
async function slaHealthCheck() {
  try {
    const workspaces = await prisma.workspace.findMany({
      where:  { status: { not: "ARCHIVED" } },
      select: { id: true },
      take:   20,
    });
    const { runHealthChecks } = await import("@/services/sla.service");
    for (const ws of workspaces) {
      await runHealthChecks(ws.id);
    }
  } catch (err) {
    log(`slaHealthCheck ERROR: ${(err as Error).message}`);
  }
}
setInterval(slaHealthCheck, 10 * 60_000);

// ── Job: KB 文件處理（每分鐘掃描 PENDING 文件）──────────────
async function processKBDocuments() {
  try {
    const pending = await prisma.kBDocument.findMany({
      where: { status: "PENDING" },
      take:  5,
      orderBy: { createdAt: "asc" },
    });
    if (!pending.length) return;

    const { processDocument } = await import("@/services/rag/rag.service");
    for (const doc of pending) {
      await processDocument(doc.id).catch(err =>
        log(`KB processDocument ${doc.id} failed: ${err.message}`)
      );
    }
    if (pending.length > 0) log(`processKBDocuments: processed ${pending.length} docs`);
  } catch (err) {
    log(`processKBDocuments ERROR: ${(err as Error).message}`);
  }
}
setInterval(processKBDocuments, 60_000);
setTimeout(processKBDocuments, 15_000);

// ── Job: 定時廣播發送（每分鐘）──────────────────────────────
async function processScheduledBroadcasts() {
  try {
    const due = await prisma.broadcast.findMany({
      where: { status:"SCHEDULED", scheduledAt:{ lte: new Date() } },
      take: 5,
    });
    for (const bc of due) {
      log(`processBroadcast: ${bc.id} "${bc.name}"`);
      // Trigger send via route handler logic
      await fetch(`http://localhost:${process.env.PORT??4000}/api/broadcasts/${bc.id}/send`, {
        method: "POST",
        headers: { "Authorization": `Bearer internal-scheduler` },
      }).catch(err => log(`broadcast send error: ${err.message}`));
    }
  } catch (err) {
    log(`processScheduledBroadcasts ERROR: ${(err as Error).message}`);
  }
}
setInterval(processScheduledBroadcasts, 60_000);

// ── Job: 智能異常偵測（每小時）──────────────────────────────
async function runAnomalyDetection() {
  try {
    const { detectAnomalies } = await import("@/services/notifications.service");
    const count = await detectAnomalies();
    if (count > 0) log(`anomalyDetection: found ${count} anomalies`);
  } catch (err) {
    log(`anomalyDetection ERROR: ${(err as Error).message}`);
  }
}
setInterval(runAnomalyDetection, 60 * 60_000);
setTimeout(runAnomalyDetection, 20_000);

// ── Job: 自動 DB 備份（每天 02:00）──────────────────────────
async function autoDatabaseBackup() {
  log("Running: autoDatabaseBackup");
  try {
    const { runDatabaseBackup } = await import("@/services/backup/db-backup.service");
    const result = await runDatabaseBackup();
    if (result.success) {
      log(`autoDatabaseBackup: success ${result.key} (${((result.sizeBytes??0)/1024/1024).toFixed(1)} MB, ${result.durationMs}ms)`);
    } else {
      log(`autoDatabaseBackup ERROR: ${result.error}`);
    }
  } catch (err) {
    log(`autoDatabaseBackup EXCEPTION: ${(err as Error).message}`);
  }
}

// Every 24 hours, check if it's 02:00
setInterval(async () => {
  const now = new Date();
  if (now.getHours() === 2 && now.getMinutes() === 0) {
    await autoDatabaseBackup();
  }
}, 60_000);

// Run on startup if S3 is configured and it's been > 23 hours since last backup
setTimeout(async () => {
  if (process.env.S3_ACCESS_KEY || process.env.R2_ACCESS_KEY) {
    const lastBackup = await prisma.logEntry.findFirst({
      where: { message: { contains: "[DB Backup]" }, type: "SYSTEM" },
      orderBy: { createdAt: "desc" },
    });
    const hoursSince = lastBackup
      ? (Date.now() - lastBackup.createdAt.getTime()) / 3600_000
      : 999;
    if (hoursSince > 23) {
      log("Startup: triggering overdue DB backup");
      await autoDatabaseBackup();
    }
  }
}, 30_000);
