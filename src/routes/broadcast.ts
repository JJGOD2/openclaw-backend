// src/routes/broadcast.ts
import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/db/client";
import { requireAuth } from "@/middleware/auth";
import { AppError } from "@/middleware/errorHandler";
import { BroadcastStatus } from "@prisma/client";

const router = Router();
router.use(requireAuth);

// GET /api/broadcasts?workspaceId=
router.get("/", async (req, res, next) => {
  try {
    const { workspaceId } = z.object({ workspaceId: z.string().cuid() }).parse(req.query);
    const list = await prisma.broadcast.findMany({
      where:   { workspaceId },
      include: { segment: { select:{ name:true } } },
      orderBy: { createdAt: "desc" },
    });
    res.json(list);
  } catch (e) { next(e); }
});

// POST /api/broadcasts
router.post("/", async (req, res, next) => {
  try {
    const body = z.object({
      workspaceId:   z.string().cuid(),
      name:          z.string().min(1).max(100),
      message:       z.string().min(1).max(5000),
      platform:      z.string().default("LINE"),
      segmentId:     z.string().cuid().optional(),
      targetUserIds: z.array(z.string()).optional(),
      scheduledAt:   z.string().datetime().optional(),
    }).parse(req.body);

    const bc = await prisma.broadcast.create({
      data: {
        workspaceId:   body.workspaceId,
        name:          body.name,
        message:       body.message,
        platform:      body.platform,
        segmentId:     body.segmentId,
        targetUserIds: body.targetUserIds ?? [],
        scheduledAt:   body.scheduledAt ? new Date(body.scheduledAt) : undefined,
        status:        body.scheduledAt ? "SCHEDULED" : "DRAFT",
        totalTarget:   body.targetUserIds?.length ?? 0,
      },
    });
    res.status(201).json(bc);
  } catch (e) { next(e); }
});

// POST /api/broadcasts/:id/send — trigger immediate send
router.post("/:id/send", async (req, res, next) => {
  try {
    const broadcast = await prisma.broadcast.findUnique({
      where:   { id: req.params.id },
      include: { segment: { include: { tags: true } } },
    });
    if (!broadcast) throw new AppError(404, "Broadcast not found");
    if (!["DRAFT","SCHEDULED"].includes(broadcast.status)) {
      throw new AppError(400, `Cannot send broadcast in status: ${broadcast.status}`);
    }

    // Determine target users
    let userIds: { userId:string; platform:string }[] = [];
    if (broadcast.targetUserIds.length > 0) {
      userIds = broadcast.targetUserIds.map(uid => ({ userId: uid, platform: broadcast.platform }));
    } else if (broadcast.segment) {
      const tags = broadcast.segment.tags;
      userIds = tags
        .filter(t => broadcast.platform === "ALL" || t.platform === broadcast.platform)
        .map(t => ({ userId: t.userId, platform: t.platform }));
    }

    if (!userIds.length) {
      throw new AppError(400, "No target users found for this broadcast");
    }

    await prisma.broadcast.update({
      where: { id: broadcast.id },
      data:  { status: "SENDING", startedAt: new Date(), totalTarget: userIds.length },
    });

    // Send asynchronously
    sendBroadcastAsync(broadcast.id, broadcast.workspaceId, broadcast.message, userIds)
      .catch(err => console.error("[Broadcast]", err));

    res.json({ ok: true, totalTarget: userIds.length, broadcastId: broadcast.id });
  } catch (e) { next(e); }
});

// GET /api/broadcasts/:id/logs
router.get("/:id/logs", async (req, res, next) => {
  try {
    const logs = await prisma.broadcastLog.findMany({
      where:   { broadcastId: req.params.id },
      orderBy: { sentAt: "desc" },
      take:    200,
    });
    const succeeded = logs.filter(l=>l.success).length;
    res.json({ logs, succeeded, failed: logs.length - succeeded });
  } catch (e) { next(e); }
});

// DELETE /api/broadcasts/:id
router.delete("/:id", async (req, res, next) => {
  try {
    const bc = await prisma.broadcast.findUnique({ where:{ id:req.params.id } });
    if (!bc) throw new AppError(404, "Not found");
    if (bc.status === "SENDING") throw new AppError(400, "Cannot delete a broadcast in progress");
    await prisma.broadcast.delete({ where:{ id:req.params.id } });
    res.status(204).end();
  } catch (e) { next(e); }
});

// ── Async sender ──────────────────────────────────────────────
async function sendBroadcastAsync(
  broadcastId: string,
  workspaceId: string,
  message:     string,
  users:       { userId:string; platform:string }[]
) {
  let sent = 0, failed = 0;

  for (const { userId, platform } of users) {
    // Import and use platform-specific send
    let success = false;
    let error   = "";

    try {
      if (platform === "LINE") {
        const { linePush } = await import("@/lib/line");
        const tokenRow = await prisma.secret.findUnique({
          where: { workspaceId_name: { workspaceId, name: "LINE_CHANNEL_ACCESS_TOKEN" } },
        });
        const { decryptSecret } = await import("@/lib/crypto");
        const token = tokenRow ? decryptSecret(tokenRow.encryptedValue) : "";
        if (token) await linePush(token, userId, message);
        success = true;
      } else if (platform === "TELEGRAM") {
        // Telegram push via bot token
        const tokenRow = await prisma.secret.findUnique({
          where: { workspaceId_name: { workspaceId, name: "TELEGRAM_BOT_TOKEN" } },
        });
        const { decryptSecret } = await import("@/lib/crypto");
        const botToken = tokenRow ? decryptSecret(tokenRow.encryptedValue) : "";
        if (botToken) {
          await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type":"application/json" },
            body: JSON.stringify({ chat_id: userId, text: message }),
          });
          success = true;
        }
      } else {
        // Log-only for unsupported platforms
        success = true;
      }
    } catch (err) {
      error   = (err as Error).message;
      success = false;
    }

    await prisma.broadcastLog.create({
      data: { broadcastId, userId, platform, success, error: error || undefined },
    });

    if (success) sent++;  else failed++;
    // Rate limit: 20/sec
    await new Promise(r => setTimeout(r, 50));
  }

  await prisma.broadcast.update({
    where: { id: broadcastId },
    data:  { status: failed > sent ? "FAILED" : "COMPLETED",
             sentCount: sent, failCount: failed, completedAt: new Date() },
  });
}

export default router;
