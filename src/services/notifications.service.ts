// src/services/notifications.service.ts
// 通知中心 + 智能異常偵測
import { prisma } from "@/db/client";
import { NotifType, AnomalyType } from "@prisma/client";
import { broadcastLog } from "@/lib/websocket";

// ─────────────────────────────────────────────────────────────
// Create notification for a user
// ─────────────────────────────────────────────────────────────
export async function createNotification(params: {
  userId:      string;
  workspaceId?:string;
  type:        NotifType;
  title:       string;
  body:        string;
  url?:        string;
}): Promise<void> {
  await prisma.notification.create({ data: params });

  // Push to WebSocket so frontend can show badge immediately
  broadcastLog({
    type:        "log",
    id:          `notif-${Date.now()}`,
    workspaceId: params.workspaceId ?? "system",
    logType:     "SYSTEM",
    message:     `[通知] ${params.title}`,
    createdAt:   new Date().toISOString(),
  });
}

// ─────────────────────────────────────────────────────────────
// Notify all admins
// ─────────────────────────────────────────────────────────────
export async function notifyAdmins(params: Omit<Parameters<typeof createNotification>[0], "userId">) {
  const admins = await prisma.user.findMany({ where: { role: { in: ["ADMIN", "OPERATOR"] } } });
  await Promise.all(admins.map(u => createNotification({ ...params, userId: u.id })));
}

// ─────────────────────────────────────────────────────────────
// Smart Anomaly Detection
// Run as a scheduled job — compare today vs 7-day rolling average
// ─────────────────────────────────────────────────────────────
export async function detectAnomalies(): Promise<number> {
  let detected = 0;
  const workspaces = await prisma.workspace.findMany({
    where:  { status: "LIVE" },
    select: { id: true, client: true },
  });

  for (const ws of workspaces) {
    const today     = new Date(); today.setHours(0,0,0,0);
    const weekAgo   = new Date(today); weekAgo.setDate(weekAgo.getDate()-7);

    // Today's record
    const todayRec = await prisma.usageRecord.findFirst({
      where: { workspaceId: ws.id, date: today },
    });
    if (!todayRec) continue;

    // 7-day average (exclude today)
    const baseline = await prisma.usageRecord.aggregate({
      where: { workspaceId: ws.id, date: { gte: weekAgo, lt: today } },
      _avg:  { messages: true, costNTD: true },
    });

    const avgMessages = baseline._avg.messages ?? 0;
    const avgCost     = Number(baseline._avg.costNTD ?? 0);

    // Only check if we have baseline data
    if (avgMessages < 5) continue;

    type AnomalyCheck = { type: AnomalyType; value: number; baseline: number; metric: string; threshold: number };
    const checks: AnomalyCheck[] = [
      {
        type:      "COST_SPIKE",
        metric:    "costNTD",
        value:     Number(todayRec.costNTD),
        baseline:  avgCost,
        threshold: 2.5,   // 250% of average
      },
      {
        type:      "MESSAGE_SPIKE",
        metric:    "messages",
        value:     todayRec.messages,
        baseline:  avgMessages,
        threshold: 3.0,   // 300% of average
      },
      {
        type:      "ZERO_TRAFFIC",
        metric:    "messages",
        value:     todayRec.messages,
        baseline:  avgMessages,
        threshold: 0.1,   // less than 10% of average (check: value < baseline * threshold)
      },
    ];

    for (const check of checks) {
      const deviation = check.type === "ZERO_TRAFFIC"
        ? (check.baseline - check.value) / (check.baseline || 1) * 100
        : (check.value - check.baseline) / (check.baseline || 1) * 100;

      const triggered = check.type === "ZERO_TRAFFIC"
        ? check.value < check.baseline * check.threshold
        : check.value > check.baseline * check.threshold;

      if (!triggered) continue;

      // Check if we already detected this today
      const existing = await prisma.anomalyEvent.findFirst({
        where: {
          workspaceId: ws.id,
          type:        check.type,
          createdAt:   { gte: today },
        },
      });
      if (existing) continue;

      // Create anomaly event
      await prisma.anomalyEvent.create({
        data: {
          workspaceId: ws.id,
          type:        check.type,
          metric:      check.metric,
          value:       check.value,
          baseline:    check.baseline,
          deviation:   Math.round(deviation * 10) / 10,
        },
      });

      // Notify admins
      const title   = ANOMALY_TITLE[check.type] ?? check.type;
      const body    = `${ws.client}：${check.metric} = ${check.value.toFixed(1)}（基準 ${check.baseline.toFixed(1)}，偏差 ${deviation.toFixed(0)}%）`;
      await notifyAdmins({ workspaceId: ws.id, type: "ALERT", title, body, url: `/usage` });

      detected++;
    }
  }

  return detected;
}

const ANOMALY_TITLE: Partial<Record<AnomalyType, string>> = {
  COST_SPIKE:       "⚠️ 費用異常飆升",
  MESSAGE_SPIKE:    "📈 訊息量異常增加",
  ERROR_RATE_SPIKE: "🚨 錯誤率異常",
  LATENCY_SPIKE:    "🐌 回應速度明顯下降",
  ZERO_TRAFFIC:     "📉 流量異常為零",
};
