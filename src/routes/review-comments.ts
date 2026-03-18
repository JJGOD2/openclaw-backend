// src/routes/review-comments.ts
import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/db/client";
import { requireAuth, AuthRequest } from "@/middleware/auth";
import { AppError } from "@/middleware/errorHandler";

const router = Router();
router.use(requireAuth);

// GET /api/review/:reviewId/comments
router.get("/:reviewId/comments", async (req, res, next) => {
  try {
    const comments = await prisma.reviewComment.findMany({
      where:   { reviewId: req.params.reviewId },
      include: { user: { select: { email: true, name: true } } },
      orderBy: { createdAt: "asc" },
    });
    res.json(comments);
  } catch (e) { next(e); }
});

// POST /api/review/:reviewId/comments
router.post("/:reviewId/comments", async (req: AuthRequest, res, next) => {
  try {
    const { content } = z.object({ content: z.string().min(1).max(2000) }).parse(req.body);

    const review = await prisma.reviewQueue.findUnique({ where: { id: req.params.reviewId } });
    if (!review) throw new AppError(404, "Review not found");

    const comment = await prisma.reviewComment.create({
      data: { reviewId: req.params.reviewId, userId: req.userId!, content },
      include: { user: { select: { email: true, name: true } } },
    });
    res.status(201).json(comment);
  } catch (e) { next(e); }
});

// DELETE /api/review/comments/:id
router.delete("/comments/:id", async (req: AuthRequest, res, next) => {
  try {
    const comment = await prisma.reviewComment.findUnique({ where: { id: req.params.id } });
    if (!comment)               throw new AppError(404, "Comment not found");
    if (comment.userId !== req.userId) throw new AppError(403, "Can only delete own comments");
    await prisma.reviewComment.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (e) { next(e); }
});

export default router;
