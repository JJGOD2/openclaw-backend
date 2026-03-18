// src/routes/review.ts
// 人工審核流程 API
import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/db/client";
import { requireAuth, AuthRequest } from "@/middleware/auth";
import { AppError } from "@/middleware/errorHandler";
import { decryptSecret } from "@/lib/crypto";
import { linePush } from "@/lib/line";
import { ReviewStatus } from "@prisma/client";

const router = Router();
router.use(requireAuth);

// ── GET /api/review?workspaceId=&status=&limit= ──────────────
router.get("/", async (req, res, next) => {
  try {
    const Schema = z.object({
      workspaceId: z.string().optional(),
      status:      z.nativeEnum(ReviewStatus).optional(),
      limit:       z.coerce.number().min(1).max(100).default(20),
      cursor:      z.string().optional(),
    });
    const q = Schema.safeParse(req.query);
    if (!q.success) throw new AppError(400, q.error.message);

    const { workspaceId, status, limit, cursor } = q.data;

    const items = await prisma.reviewQueue.findMany({
      where: {
        ...(workspaceId ? { workspaceId } : {}),
        ...(status      ? { status }      : {}),
      },
      orderBy: { createdAt: "desc" },
      take:    limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: {
        workspace: { select: { client: true, name: true } },
      },
    });

    const hasMore    = items.length > limit;
    const data       = hasMore ? items.slice(0, limit) : items;
    const nextCursor = hasMore ? data[data.length - 1].id : null;

    // Summary counts
    const counts = await prisma.reviewQueue.groupBy({
      by: ["status"],
      where: workspaceId ? { workspaceId } : {},
      _count: true,
    });

    res.json({ items: data, nextCursor, counts });
  } catch (e) { next(e); }
});

// ── GET /api/review/:id ──────────────────────────────────────
router.get("/:id", async (req, res, next) => {
  try {
    const item = await prisma.reviewQueue.findUnique({
      where: { id: req.params.id },
      include: { workspace: { select: { client: true, name: true } } },
    });
    if (!item) throw new AppError(404, "Review item not found");
    res.json(item);
  } catch (e) { next(e); }
});

// ── POST /api/review/:id/approve ─────────────────────────────
// 核准 AI 草稿原文發送
router.post("/:id/approve", async (req: AuthRequest, res, next) => {
  try {
    const item = await prisma.reviewQueue.findUnique({ where: { id: req.params.id } });
    if (!item)                      throw new AppError(404, "Review item not found");
    if (item.status !== "PENDING")  throw new AppError(400, "Item is not pending");

    await sendReply(item.workspaceId, item.platform, item.userId, item.aiDraft, item.replyToken);

    const updated = await prisma.reviewQueue.update({
      where: { id: req.params.id },
      data:  { status: "APPROVED", reviewedBy: req.userId, reviewedAt: new Date(), sentAt: new Date() },
    });

    await prisma.logEntry.create({
      data: {
        workspaceId: item.workspaceId,
        type:        "SYSTEM",
        message:     `[審核] ${item.platform} 訊息已核准發送，審核者 ${req.userId}`,
      },
    });

    res.json(updated);
  } catch (e) { next(e); }
});

// ── POST /api/review/:id/reject ──────────────────────────────
router.post("/:id/reject", async (req: AuthRequest, res, next) => {
  try {
    const { note } = z.object({ note: z.string().optional() }).parse(req.body);
    const item = await prisma.reviewQueue.findUnique({ where: { id: req.params.id } });
    if (!item)                     throw new AppError(404, "Review item not found");
    if (item.status !== "PENDING") throw new AppError(400, "Item is not pending");

    const updated = await prisma.reviewQueue.update({
      where: { id: req.params.id },
      data:  { status: "REJECTED", reviewedBy: req.userId, reviewedAt: new Date(), note },
    });

    await prisma.logEntry.create({
      data: {
        workspaceId: item.workspaceId,
        type:        "SYSTEM",
        message:     `[審核] ${item.platform} 訊息已拒絕，不發送。備注：${note ?? "—"}`,
      },
    });

    res.json(updated);
  } catch (e) { next(e); }
});

// ── POST /api/review/:id/edit-send ───────────────────────────
// 人工改稿後發送
router.post("/:id/edit-send", async (req: AuthRequest, res, next) => {
  try {
    const { editedReply, note } = z.object({
      editedReply: z.string().min(1),
      note:        z.string().optional(),
    }).parse(req.body);

    const item = await prisma.reviewQueue.findUnique({ where: { id: req.params.id } });
    if (!item)                     throw new AppError(404, "Review item not found");
    if (item.status !== "PENDING") throw new AppError(400, "Item is not pending");

    await sendReply(item.workspaceId, item.platform, item.userId, editedReply, item.replyToken);

    const updated = await prisma.reviewQueue.update({
      where: { id: req.params.id },
      data: {
        status:      "EDITED",
        editedReply,
        reviewedBy:  req.userId,
        reviewedAt:  new Date(),
        sentAt:      new Date(),
        note,
      },
    });

    await prisma.logEntry.create({
      data: {
        workspaceId: item.workspaceId,
        type:        "SYSTEM",
        message:     `[審核] ${item.platform} 訊息人工改稿後發送`,
      },
    });

    res.json(updated);
  } catch (e) { next(e); }
});

// ── Helper: send reply based on platform ─────────────────────
async function sendReply(
  workspaceId: string,
  platform:    string,
  userId:      string,
  text:        string,
  replyToken?: string | null
) {
  if (platform === "LINE") {
    const tokenRow = await prisma.secret.findUnique({
      where: { workspaceId_name: { workspaceId, name: "LINE_CHANNEL_ACCESS_TOKEN" } },
    });
    if (!tokenRow) throw new AppError(500, "LINE_CHANNEL_ACCESS_TOKEN not configured");
    const accessToken = tokenRow.encryptedValue.startsWith("PLACEHOLDER")
      ? process.env.LINE_CHANNEL_ACCESS_TOKEN ?? ""
      : decryptSecret(tokenRow.encryptedValue);
    // Prefer push (replyToken may have expired after review)
    await linePush(accessToken, userId, [{ type: "text", text }]);
  }
  // TODO: implement TELEGRAM, SLACK push
}

export default router;
