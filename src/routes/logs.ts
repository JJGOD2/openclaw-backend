// src/routes/logs.ts
import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/db/client";
import { requireAuth } from "@/middleware/auth";
import { AppError } from "@/middleware/errorHandler";
import { LogType } from "@prisma/client";

const router = Router();
router.use(requireAuth);

// GET /api/logs?workspaceId=&type=&limit=&cursor=
router.get("/", async (req, res, next) => {
  try {
    const Schema = z.object({
      workspaceId: z.string().optional(),
      type:        z.nativeEnum(LogType).optional(),
      limit:       z.coerce.number().min(1).max(200).default(50),
      cursor:      z.string().optional(),           // log entry id for pagination
    });
    const q = Schema.safeParse(req.query);
    if (!q.success) throw new AppError(400, q.error.message);

    const { workspaceId, type, limit, cursor } = q.data;

    const logs = await prisma.logEntry.findMany({
      where: {
        ...(workspaceId ? { workspaceId } : {}),
        ...(type        ? { type }        : {}),
      },
      orderBy: { createdAt: "desc" },
      take:    limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = logs.length > limit;
    const items   = hasMore ? logs.slice(0, limit) : logs;
    const nextCursor = hasMore ? items[items.length - 1].id : null;

    res.json({ items, nextCursor });
  } catch (e) { next(e); }
});

// POST /api/logs  — internal log ingestion endpoint
router.post("/", async (req, res, next) => {
  try {
    const Schema = z.object({
      workspaceId: z.string().cuid(),
      type:        z.nativeEnum(LogType),
      message:     z.string().min(1),
      metadata:    z.record(z.unknown()).optional(),
    });
    const body = Schema.safeParse(req.body);
    if (!body.success) throw new AppError(400, body.error.message);

    const log = await prisma.logEntry.create({ data: body.data });
    res.status(201).json(log);
  } catch (e) { next(e); }
});

export default router;
