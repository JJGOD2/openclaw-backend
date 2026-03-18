// src/routes/audit.ts
import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/db/client";
import { requireAuth, requireAdmin, AuthRequest } from "@/middleware/auth";
import { AppError } from "@/middleware/errorHandler";

const router = Router();
router.use(requireAuth);

// GET /api/audit?limit=&cursor=&action=&userId=
router.get("/", async (req, res, next) => {
  try {
    const q = z.object({
      limit:    z.coerce.number().min(1).max(200).default(50),
      cursor:   z.string().optional(),
      action:   z.string().optional(),    // prefix filter, comma-separated
      userId:   z.string().optional(),
    }).parse(req.query);

    const actionPrefixes = q.action?.split(",").filter(Boolean) ?? [];

    const items = await prisma.auditLog.findMany({
      where: {
        ...(q.userId ? { userId: q.userId } : {}),
        ...(actionPrefixes.length
          ? { OR: actionPrefixes.map(p => ({ action: { startsWith: p } })) }
          : {}),
      },
      orderBy: { createdAt: "desc" },
      take:    q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      include: { user: { select: { email: true, name: true } } },
    });

    const hasMore    = items.length > q.limit;
    const data       = hasMore ? items.slice(0, q.limit) : items;
    const nextCursor = hasMore ? data[data.length - 1].id : null;
    res.json({ items: data, nextCursor });
  } catch (e) { next(e); }
});

// POST /api/audit — internal: create audit log entry
router.post("/", async (req: AuthRequest, res, next) => {
  try {
    const Schema = z.object({
      action:  z.string().min(1),
      target:  z.string().optional(),
      detail:  z.record(z.unknown()).optional(),
    });
    const body = Schema.safeParse(req.body);
    if (!body.success) throw new AppError(400, body.error.message);

    const log = await prisma.auditLog.create({
      data: {
        userId: req.userId!,
        action: body.data.action,
        target: body.data.target,
        detail: body.data.detail,
        ip:     req.ip ?? req.socket.remoteAddress ?? null,
      },
    });
    res.status(201).json(log);
  } catch (e) { next(e); }
});

// GET /api/audit/export (Admin only — CSV)
router.get("/export", requireAdmin, async (_req, res, next) => {
  try {
    const logs = await prisma.auditLog.findMany({
      orderBy: { createdAt: "desc" },
      take:    5000,
      include: { user: { select: { email: true } } },
    });

    const csv = [
      "time,user,action,target,ip",
      ...logs.map(l => [
        l.createdAt.toISOString(),
        l.user.email,
        l.action,
        l.target ?? "",
        l.ip ?? "",
      ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(","))
    ].join("\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="audit-log-${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(csv);
  } catch (e) { next(e); }
});

export default router;
