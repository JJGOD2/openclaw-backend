// src/routes/super-admin.ts
// 超級管理員 API — 跨所有 Workspace 的系統管理
// 只有 role=SUPER_ADMIN 可以存取
import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { prisma } from "@/db/client";
import { requireAuth, AuthRequest } from "@/middleware/auth";
import { AppError } from "@/middleware/errorHandler";

const router = Router();
router.use(requireAuth);

// Super admin guard
async function requireSuperAdmin(req: AuthRequest, _res: Response, next: NextFunction) {
  const user = await prisma.user.findUnique({ where: { id: req.userId! } });
  if (!user || user.role !== "SUPER_ADMIN") {
    return next(new AppError(403, "Super admin access required"));
  }
  next();
}
router.use(requireSuperAdmin as unknown as (req: Request, res: Response, next: NextFunction) => void);

// ── GET /api/super/overview ───────────────────────────────────
router.get("/overview", async (_req, res, next) => {
  try {
    const [
      workspaceCount, userCount, agentCount,
      todayMessages, monthCost, activeChains,
      pendingHandoffs, pendingReviews,
    ] = await Promise.all([
      prisma.workspace.count(),
      prisma.user.count(),
      prisma.agent.count(),
      prisma.usageRecord.aggregate({
        where: { date: { gte: (() => { const d=new Date(); d.setHours(0,0,0,0); return d; })() } },
        _sum:  { messages: true },
      }),
      prisma.usageRecord.aggregate({
        where: { date: { gte: (() => { const d=new Date(); d.setDate(1); d.setHours(0,0,0,0); return d; })() } },
        _sum:  { costNTD: true },
      }),
      prisma.agentChain.count({ where: { enabled: true } }),
      prisma.handoffQueue.count({ where: { status: "PENDING" } }),
      prisma.reviewQueue.count({ where: { status: "PENDING" } }),
    ]);

    // Per-workspace breakdown
    const workspaces = await prisma.workspace.findMany({
      select: { id:true, name:true, client:true, plan:true, status:true },
      orderBy:{ createdAt: "desc" },
    });

    const wsUsage = await prisma.usageRecord.groupBy({
      by:     ["workspaceId"],
      where:  { date: { gte: new Date(Date.now() - 30 * 86_400_000) } },
      _sum:   { messages: true, costNTD: true },
    });
    const usageMap = Object.fromEntries(
      wsUsage.map(u => [u.workspaceId, { messages: u._sum.messages??0, cost: Number(u._sum.costNTD??0) }])
    );

    res.json({
      system: {
        workspaceCount,
        userCount,
        agentCount,
        activeChains,
        todayMessages:  todayMessages._sum.messages ?? 0,
        monthCostNTD:   Number(monthCost._sum.costNTD ?? 0).toFixed(0),
        pendingHandoffs,
        pendingReviews,
      },
      workspaces: workspaces.map(ws => ({
        ...ws,
        usage: usageMap[ws.id] ?? { messages: 0, cost: 0 },
      })),
    });
  } catch (e) { next(e); }
});

// ── GET /api/super/users ──────────────────────────────────────
router.get("/users", async (req, res, next) => {
  try {
    const { search, limit } = z.object({
      search: z.string().optional(),
      limit:  z.coerce.number().default(50),
    }).parse(req.query);

    const users = await prisma.user.findMany({
      where:   search ? { OR: [
        { email: { contains: search, mode: "insensitive" } },
        { name:  { contains: search, mode: "insensitive" } },
      ]} : {},
      orderBy: { createdAt: "desc" },
      take:    Math.min(limit, 200),
      select:  { id:true, email:true, name:true, role:true, createdAt:true },
    });
    res.json(users);
  } catch (e) { next(e); }
});

// ── PATCH /api/super/users/:id/role ──────────────────────────
router.patch("/users/:id/role", async (req, res, next) => {
  try {
    const { role } = z.object({ role: z.enum(["USER","ADMIN","SUPER_ADMIN"]) }).parse(req.body);
    const user = await prisma.user.update({ where: { id: req.params.id }, data: { role: role as never } });
    res.json({ id: user.id, email: user.email, role: user.role });
  } catch (e) { next(e); }
});

// ── GET /api/super/system-health ─────────────────────────────
router.get("/system-health", async (_req, res, next) => {
  try {
    const [dbOk, slowQueries, failedJobs] = await Promise.all([
      prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
      prisma.logEntry.count({ where: {
        type: "ERROR", createdAt: { gte: new Date(Date.now() - 3600_000) },
      }}),
      prisma.webhookDLQ.count({ where: { status: "DEAD" } }),
    ]);

    const pendingKBDocs = await prisma.kBDocument.count({ where: { status: "PENDING" } });
    const failedKBDocs  = await prisma.kBDocument.count({ where: { status: "FAILED" } });
    const expiredTokens = await prisma.oAuthToken.count({ where: {
      expiresAt: { lt: new Date() }, isValid: true,
    }});

    res.json({
      database:     { ok: dbOk },
      recentErrors: slowQueries,
      deadWebhooks: failedJobs,
      kb: { pending: pendingKBDocs, failed: failedKBDocs },
      oauth: { expiredButValid: expiredTokens },
      timestamp: new Date().toISOString(),
    });
  } catch (e) { next(e); }
});

// ── POST /api/super/workspaces/:id/impersonate ────────────────
// Generate a short-lived token to access a workspace as admin
router.post("/workspaces/:id/impersonate", async (req: AuthRequest, res, next) => {
  try {
    const ws = await prisma.workspace.findUnique({ where: { id: req.params.id } });
    if (!ws) throw new AppError(404, "Workspace not found");

    // Log this action
    await prisma.auditLog.create({
      data: {
        userId: req.userId!,
        action: "super.impersonate",
        target: `workspace:${ws.id}`,
        detail: { workspaceName: ws.name, client: ws.client },
      },
    });

    // Return workspace context (frontend can use this to switch context)
    res.json({
      workspaceId: ws.id,
      name:        ws.name,
      client:      ws.client,
      note:        "已切換到此 Workspace 視角（此操作已記錄在 Audit Log）",
    });
  } catch (e) { next(e); }
});

// ── DELETE /api/super/workspaces/:id ─────────────────────────
router.delete("/workspaces/:id", async (req: AuthRequest, res, next) => {
  try {
    const { confirm } = z.object({ confirm: z.literal("DELETE") }).parse(req.body);

    const ws = await prisma.workspace.findUnique({ where: { id: req.params.id } });
    if (!ws) throw new AppError(404, "Workspace not found");

    await prisma.workspace.delete({ where: { id: req.params.id } });

    await prisma.auditLog.create({
      data: {
        userId: req.userId!,
        action: "super.workspace.delete",
        target: `workspace:${req.params.id}`,
        detail: { workspaceName: ws.name, client: ws.client },
      },
    });

    res.json({ ok: true, deleted: ws.name });
  } catch (e) { next(e); }
});

// ── GET /api/super/audit?limit=&action= ──────────────────────
router.get("/audit", async (req, res, next) => {
  try {
    const { limit, action } = z.object({
      limit:  z.coerce.number().default(100),
      action: z.string().optional(),
    }).parse(req.query);

    const logs = await prisma.auditLog.findMany({
      where:   action ? { action: { startsWith: action } } : {},
      orderBy: { createdAt: "desc" },
      take:    Math.min(limit, 500),
      include: { user: { select: { email: true } } },
    });
    res.json(logs);
  } catch (e) { next(e); }
});

export default router;
