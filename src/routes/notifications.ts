// src/routes/notifications.ts
import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/db/client";
import { requireAuth, AuthRequest } from "@/middleware/auth";
import { AppError } from "@/middleware/errorHandler";

const router = Router();
router.use(requireAuth);

// GET /api/notifications?limit=&unreadOnly=
router.get("/", async (req: AuthRequest, res, next) => {
  try {
    const { limit, unreadOnly } = z.object({
      limit:      z.coerce.number().min(1).max(100).default(30),
      unreadOnly: z.enum(["true","false"]).default("false"),
    }).parse(req.query);

    const notifs = await prisma.notification.findMany({
      where: {
        userId: req.userId!,
        ...(unreadOnly==="true" ? { read: false } : {}),
      },
      orderBy: { createdAt: "desc" },
      take:    limit,
    });

    const unreadCount = await prisma.notification.count({
      where: { userId: req.userId!, read: false },
    });

    res.json({ items: notifs, unreadCount });
  } catch (e) { next(e); }
});

// PATCH /api/notifications/:id/read
router.patch("/:id/read", async (req: AuthRequest, res, next) => {
  try {
    const n = await prisma.notification.findUnique({ where: { id: req.params.id } });
    if (!n || n.userId !== req.userId!) throw new AppError(404, "Not found");

    await prisma.notification.update({
      where: { id: req.params.id },
      data:  { read: true, readAt: new Date() },
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// POST /api/notifications/read-all
router.post("/read-all", async (req: AuthRequest, res, next) => {
  try {
    const result = await prisma.notification.updateMany({
      where: { userId: req.userId!, read: false },
      data:  { read: true, readAt: new Date() },
    });
    res.json({ marked: result.count });
  } catch (e) { next(e); }
});

// DELETE /api/notifications/:id
router.delete("/:id", async (req: AuthRequest, res, next) => {
  try {
    const n = await prisma.notification.findUnique({ where: { id: req.params.id } });
    if (!n || n.userId !== req.userId!) throw new AppError(404, "Not found");
    await prisma.notification.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (e) { next(e); }
});

// GET /api/notifications/anomalies?workspaceId=
router.get("/anomalies", async (req, res, next) => {
  try {
    const { workspaceId } = z.object({ workspaceId: z.string().cuid().optional() }).parse(req.query);
    const anomalies = await prisma.anomalyEvent.findMany({
      where:   workspaceId ? { workspaceId } : {},
      orderBy: { createdAt: "desc" },
      take:    50,
    });
    res.json(anomalies);
  } catch (e) { next(e); }
});

// PATCH /api/notifications/anomalies/:id/ack
router.patch("/anomalies/:id/ack", async (req, res, next) => {
  try {
    const a = await prisma.anomalyEvent.update({
      where: { id: req.params.id },
      data:  { acknowledged: true },
    });
    res.json(a);
  } catch (e) { next(e); }
});

export default router;
