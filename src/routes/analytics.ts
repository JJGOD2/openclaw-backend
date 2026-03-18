// src/routes/analytics.ts
import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/db/client";
import { requireAuth } from "@/middleware/auth";
import { AppError } from "@/middleware/errorHandler";

const router = Router();
router.use(requireAuth);

// ── GET /api/analytics/overview?workspaceId=&days= ────────────
router.get("/overview", async (req, res, next) => {
  try {
    const { workspaceId, days } = z.object({
      workspaceId: z.string().cuid().optional(),
      days:        z.coerce.number().min(7).max(365).default(30),
    }).parse(req.query);

    const since = new Date();
    since.setDate(since.getDate() - days);

    const where = {
      ...(workspaceId ? { workspaceId } : {}),
      date: { gte: since },
    };

    // Aggregate totals
    const totals = await prisma.usageRecord.aggregate({
      where,
      _sum: {
        messages:     true,
        inputTokens:  true,
        outputTokens: true,
        apiCalls:     true,
        toolExecs:    true,
        costNTD:      true,
      },
      _avg: { messages: true },
    });

    // Daily trend
    const daily = await prisma.usageRecord.findMany({
      where,
      orderBy: { date: "asc" },
      select:  { date: true, messages: true, inputTokens: true, outputTokens: true, costNTD: true },
    });

    // Channel breakdown (from logs)
    const chatLogs = await prisma.logEntry.groupBy({
      by:    ["workspaceId"],
      where: {
        type:      "CHAT",
        createdAt: { gte: since },
        ...(workspaceId ? { workspaceId } : {}),
      },
      _count: true,
    });

    // Error rate
    const [totalTools, errorTools] = await Promise.all([
      prisma.logEntry.count({ where: { ...where.workspaceId ? { workspaceId } : {}, type: "TOOL",  createdAt: { gte: since } } }),
      prisma.logEntry.count({ where: { ...workspaceId ? { workspaceId } : {},        type: "ERROR", createdAt: { gte: since } } }),
    ]);
    const errorRate = totalTools > 0 ? (errorTools / totalTools) * 100 : 0;

    // Active sessions
    const activeSessions = await prisma.conversationSession.count({
      where: {
        isActive: true,
        ...(workspaceId ? { workspaceId } : {}),
        lastActiveAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
    });

    // Review queue stats
    const reviewStats = await prisma.reviewQueue.groupBy({
      by:    ["status"],
      where: {
        ...(workspaceId ? { workspaceId } : {}),
        createdAt: { gte: since },
      },
      _count: true,
    });

    res.json({
      period:      { days, since },
      totals: {
        messages:     totals._sum.messages     ?? 0,
        inputTokens:  totals._sum.inputTokens  ?? 0,
        outputTokens: totals._sum.outputTokens ?? 0,
        apiCalls:     totals._sum.apiCalls     ?? 0,
        toolExecs:    totals._sum.toolExecs    ?? 0,
        costNTD:      Number(totals._sum.costNTD ?? 0),
        avgDailyMsgs: Math.round(totals._avg.messages ?? 0),
      },
      errorRate:      Math.round(errorRate * 10) / 10,
      activeSessions,
      daily:          daily.map(d => ({
        date:    d.date.toISOString().slice(0, 10),
        messages:d.messages,
        tokens:  d.inputTokens + d.outputTokens,
        cost:    Number(d.costNTD),
      })),
      reviewBreakdown: Object.fromEntries(reviewStats.map(r => [r.status, r._count])),
    });
  } catch (e) { next(e); }
});

// ── GET /api/analytics/agents?workspaceId=&days= ──────────────
router.get("/agents", async (req, res, next) => {
  try {
    const { workspaceId, days } = z.object({
      workspaceId: z.string().cuid().optional(),
      days:        z.coerce.number().min(1).max(90).default(30),
    }).parse(req.query);

    const since = new Date();
    since.setDate(since.getDate() - days);

    const agents = await prisma.agent.findMany({
      where: workspaceId ? { workspaceId } : {},
      include: {
        workspace: { select: { client: true, name: true } },
      },
    });

    // For each agent, count interactions from log entries
    const agentStats = await Promise.all(agents.map(async (agent) => {
      const [total, errors] = await Promise.all([
        prisma.logEntry.count({
          where: {
            workspaceId: agent.workspaceId,
            type:        "CHAT",
            createdAt:   { gte: since },
            message:     { contains: agent.name },
          },
        }),
        prisma.logEntry.count({
          where: {
            workspaceId: agent.workspaceId,
            type:        "ERROR",
            createdAt:   { gte: since },
            metadata:    { path: ["agentId"], equals: agent.id },
          },
        }),
      ]);

      return {
        id:           agent.id,
        name:         agent.name,
        role:         agent.role,
        workspaceName:agent.workspace.client,
        status:       agent.status,
        conversations:total,
        errors,
        errorRate:    total > 0 ? Math.round((errors / total) * 1000) / 10 : 0,
      };
    }));

    // Sort by conversations desc
    agentStats.sort((a, b) => b.conversations - a.conversations);
    res.json(agentStats);
  } catch (e) { next(e); }
});

// ── GET /api/analytics/retention?workspaceId=&days= ──────────
// 用戶回訪率（有多少 userId 回來了第二次 / 第三次+）
router.get("/retention", async (req, res, next) => {
  try {
    const { workspaceId, days } = z.object({
      workspaceId: z.string().cuid().optional(),
      days:        z.coerce.number().default(30),
    }).parse(req.query);

    const since = new Date();
    since.setDate(since.getDate() - days);

    const sessions = await prisma.conversationSession.findMany({
      where: {
        ...(workspaceId ? { workspaceId } : {}),
        createdAt: { gte: since },
      },
      select: { userId: true, platform: true },
    });

    // Count sessions per user
    const userCounts = new Map<string, number>();
    for (const s of sessions) {
      const key = `${s.platform}:${s.userId}`;
      userCounts.set(key, (userCounts.get(key) ?? 0) + 1);
    }

    const total     = userCounts.size;
    const returning = Array.from(userCounts.values()).filter(c => c >= 2).length;
    const loyal     = Array.from(userCounts.values()).filter(c => c >= 5).length;

    res.json({
      period:          { days },
      totalUsers:      total,
      newUsers:        total - returning,
      returningUsers:  returning,
      loyalUsers:      loyal,
      retentionRate:   total > 0 ? Math.round((returning / total) * 1000) / 10 : 0,
    });
  } catch (e) { next(e); }
});

// ── GET /api/analytics/cost-forecast?workspaceId= ────────────
router.get("/cost-forecast", async (req, res, next) => {
  try {
    const { workspaceId } = z.object({ workspaceId: z.string().cuid().optional() }).parse(req.query);

    const startOfMonth = new Date();
    startOfMonth.setDate(1); startOfMonth.setHours(0, 0, 0, 0);

    const records = await prisma.usageRecord.findMany({
      where: {
        ...(workspaceId ? { workspaceId } : {}),
        date: { gte: startOfMonth },
      },
      orderBy: { date: "asc" },
    });

    const daysInMonth = new Date(startOfMonth.getFullYear(), startOfMonth.getMonth() + 1, 0).getDate();
    const daysPassed  = Math.max(1, new Date().getDate());

    const mtdCost     = records.reduce((s, r) => s + Number(r.costNTD), 0);
    const dailyAvg    = mtdCost / daysPassed;
    const forecast    = dailyAvg * daysInMonth;

    res.json({
      monthToDate:    Math.round(mtdCost),
      dailyAverage:   Math.round(dailyAvg),
      forecast:       Math.round(forecast),
      daysRemaining:  daysInMonth - daysPassed,
      dailyData:      records.map(r => ({
        date:    r.date.toISOString().slice(0, 10),
        costNTD: Number(r.costNTD),
      })),
    });
  } catch (e) { next(e); }
});

export default router;
