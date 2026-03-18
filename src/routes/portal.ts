// src/routes/portal.ts
// 客戶自助入口後端 — 公開端點，不需 JWT
import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/db/client";
import { AppError } from "@/middleware/errorHandler";
import { rateLimit } from "@/middleware/rateLimit";

const router = Router();

// Portal-specific rate limit: 10 req/min per IP
const portalLimit = rateLimit({ windowMs: 60_000, max: 10 });

// GET /portal/sessions?userId=&platform=
router.get("/sessions", portalLimit, async (req, res, next) => {
  try {
    const { userId, platform } = z.object({
      userId:   z.string().min(1).max(200),
      platform: z.string().optional(),
    }).parse(req.query);

    const sessions = await prisma.conversationSession.findMany({
      where: {
        userId,
        ...(platform ? { platform: platform.toUpperCase() } : {}),
        isActive: true,
      },
      select: {
        id:          true,
        platform:    true,
        title:       true,
        messageCount:true,
        lastActiveAt:true,
      },
      orderBy: { lastActiveAt: "desc" },
      take:    20,
    });

    res.json({ sessions });
  } catch (e) { next(e); }
});

// GET /portal/sessions/:id — public session detail (messages only)
router.get("/sessions/:id", portalLimit, async (req, res, next) => {
  try {
    const session = await prisma.conversationSession.findUnique({
      where:   { id: req.params.id },
      include: {
        messages: {
          select:  { role: true, content: true, createdAt: true },
          orderBy: { createdAt: "asc" },
          take:    100,
        },
      },
    });
    if (!session) throw new AppError(404, "Session not found");

    res.json({
      id:       session.id,
      platform: session.platform,
      title:    session.title,
      messages: session.messages,
    });
  } catch (e) { next(e); }
});

export default router;
