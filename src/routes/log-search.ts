// src/routes/log-search.ts
import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/db/client";
import { requireAuth } from "@/middleware/auth";

const router = Router();
router.use(requireAuth);

// POST /api/log-search — full-text + filter search
router.post("/", async (req, res, next) => {
  try {
    const body = z.object({
      workspaceId: z.string().cuid().optional(),
      query:       z.string().optional(),
      types:       z.array(z.string()).optional(),
      startTime:   z.string().datetime().optional(),
      endTime:     z.string().datetime().optional(),
      limit:       z.number().min(1).max(500).default(100),
      cursor:      z.string().optional(),
    }).parse(req.body);

    const where: Record<string, unknown> = {};
    if (body.workspaceId) where.workspaceId = body.workspaceId;
    if (body.types?.length) where.type = { in: body.types };
    if (body.query?.trim()) {
      where.message = { contains: body.query.trim(), mode: "insensitive" };
    }
    if (body.startTime || body.endTime) {
      where.createdAt = {
        ...(body.startTime ? { gte: new Date(body.startTime) } : {}),
        ...(body.endTime   ? { lte: new Date(body.endTime)   } : {}),
      };
    }

    const [items, total] = await Promise.all([
      prisma.logEntry.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take:    body.limit + 1,
        ...(body.cursor ? { cursor: { id: body.cursor }, skip: 1 } : {}),
      }),
      prisma.logEntry.count({ where }),
    ]);

    const hasMore    = items.length > body.limit;
    const data       = hasMore ? items.slice(0, body.limit) : items;
    const nextCursor = hasMore ? data[data.length - 1].id : null;

    res.json({ items: data, nextCursor, total });
  } catch (e) { next(e); }
});

// GET /api/log-search/agg?workspaceId=&hours= — aggregations for charts
router.get("/agg", async (req, res, next) => {
  try {
    const { workspaceId, hours } = z.object({
      workspaceId: z.string().cuid().optional(),
      hours:       z.coerce.number().default(24),
    }).parse(req.query);

    const since = new Date(Date.now() - hours * 3600_000);
    const where = {
      ...(workspaceId ? { workspaceId } : {}),
      createdAt: { gte: since },
    };

    // Count by type
    const byType = await prisma.logEntry.groupBy({
      by:    ["type"],
      where,
      _count:{ id: true },
      orderBy:{ _count:{ id:"desc" } },
    });

    // Count by workspace (if no filter)
    const byWorkspace = workspaceId ? [] : await prisma.logEntry.groupBy({
      by:    ["workspaceId"],
      where,
      _count:{ id: true },
      orderBy:{ _count:{ id:"desc" } },
      take:  10,
    });

    // Error rate over time (hourly buckets)
    const allLogs = await prisma.logEntry.findMany({
      where,
      select: { type: true, createdAt: true },
      take:   5000,
    });

    // Group into hourly buckets
    const buckets: Record<string, { total:number; errors:number }> = {};
    for (const log of allLogs) {
      const h = new Date(log.createdAt);
      h.setMinutes(0,0,0);
      const key = h.toISOString();
      if (!buckets[key]) buckets[key] = { total:0, errors:0 };
      buckets[key].total++;
      if (log.type === "ERROR") buckets[key].errors++;
    }

    const timeline = Object.entries(buckets)
      .sort(([a],[b]) => a.localeCompare(b))
      .map(([time, v]) => ({
        time,
        total:     v.total,
        errors:    v.errors,
        errorRate: v.total ? Math.round(v.errors/v.total*1000)/10 : 0,
      }));

    // Top error messages
    const topErrors = await prisma.logEntry.groupBy({
      by:    ["message"],
      where: { ...where, type: "ERROR" },
      _count:{ id: true },
      orderBy:{ _count:{ id:"desc" } },
      take:  5,
    });

    res.json({
      period:      { hours, since },
      totalLogs:   allLogs.length,
      byType:      byType.map(r => ({ type: r.type, count: r._count.id })),
      byWorkspace: byWorkspace.map(r => ({ workspaceId: r.workspaceId, count: r._count.id })),
      timeline,
      topErrors:   topErrors.map(r => ({ message: r.message.slice(0,120), count: r._count.id })),
    });
  } catch (e) { next(e); }
});

export default router;
