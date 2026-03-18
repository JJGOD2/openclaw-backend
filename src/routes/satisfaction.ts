// src/routes/satisfaction.ts
import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/db/client";
import { requireAuth } from "@/middleware/auth";
import { AppError } from "@/middleware/errorHandler";
import { SurveyStatus } from "@prisma/client";

const router = Router();

// ── Public: Submit rating (no auth, called from chat flow) ───
// POST /api/satisfaction/respond/:surveyId
router.post("/respond/:surveyId", async (req, res, next) => {
  try {
    const { rating, comment, tags } = z.object({
      rating:  z.number().min(1).max(5),
      comment: z.string().max(500).optional(),
      tags:    z.array(z.string()).default([]),
    }).parse(req.body);

    const survey = await prisma.satisfactionSurvey.findUnique({
      where: { id: req.params.surveyId },
    });
    if (!survey) throw new AppError(404, "Survey not found");
    if (survey.status !== "PENDING") {
      return res.json({ ok: false, message: "已回覆過" });
    }
    if (survey.expiresAt && survey.expiresAt < new Date()) {
      await prisma.satisfactionSurvey.update({
        where: { id: survey.id }, data: { status: "EXPIRED" },
      });
      return res.json({ ok: false, message: "問卷已過期" });
    }

    await prisma.satisfactionSurvey.update({
      where: { id: survey.id },
      data:  { rating, comment, tags, status: "COMPLETED", answeredAt: new Date() },
    });

    res.json({ ok: true, message: "感謝您的評分！" });
  } catch (e) { next(e); }
});

// ── Authenticated routes ──────────────────────────────────────
router.use(requireAuth);

// POST /api/satisfaction — create and send survey
router.post("/", async (req, res, next) => {
  try {
    const body = z.object({
      workspaceId: z.string().cuid(),
      agentId:     z.string().cuid().optional(),
      sessionId:   z.string().optional(),
      platform:    z.string(),
      userId:      z.string(),
      expiresInHours: z.number().default(24),
    }).parse(req.body);

    const expiresAt = new Date(Date.now() + body.expiresInHours * 3600_000);
    const survey    = await prisma.satisfactionSurvey.create({
      data: { ...body, expiresAt, status: "PENDING" },
    });

    // Build rating URL (deep link to portal or LINE LIFF)
    const baseUrl    = process.env.FRONTEND_URL ?? "http://localhost:3000";
    const surveyUrl  = `${baseUrl}/portal/rate/${survey.id}`;

    res.status(201).json({ survey, surveyUrl });
  } catch (e) { next(e); }
});

// GET /api/satisfaction/stats?workspaceId=&days=
router.get("/stats", async (req, res, next) => {
  try {
    const { workspaceId, days } = z.object({
      workspaceId: z.string().cuid(),
      days:        z.coerce.number().default(30),
    }).parse(req.query);

    const since = new Date(Date.now() - days * 86_400_000);

    const surveys = await prisma.satisfactionSurvey.findMany({
      where:   { workspaceId, sentAt: { gte: since } },
      select:  { rating: true, tags: true, status: true, answeredAt: true, platform: true },
    });

    const completed = surveys.filter(s => s.status === "COMPLETED" && s.rating !== null);
    const ratings   = completed.map(s => s.rating!);
    const avg       = ratings.length ? ratings.reduce((a,b)=>a+b,0)/ratings.length : 0;

    // NPS-like: 5=promoter(100), 4=passive(0), 1-3=detractor(-100)
    const promoters  = ratings.filter(r=>r===5).length;
    const detractors = ratings.filter(r=>r<=3).length;
    const nps        = ratings.length
      ? Math.round(((promoters - detractors) / ratings.length) * 100) : 0;

    // Rating distribution
    const dist = [1,2,3,4,5].map(r => ({
      rating: r,
      count:  ratings.filter(x=>x===r).length,
    }));

    // Tag frequency
    const tagCounts: Record<string,number> = {};
    for (const s of completed) {
      for (const tag of s.tags) tagCounts[tag] = (tagCounts[tag]??0) + 1;
    }

    // Response rate
    const total        = surveys.length;
    const responseRate = total ? Math.round(completed.length/total*100) : 0;

    // Trend: daily average
    const dailyMap: Record<string,number[]> = {};
    for (const s of completed) {
      const day = s.answeredAt!.toISOString().slice(0,10);
      if (!dailyMap[day]) dailyMap[day] = [];
      dailyMap[day].push(s.rating!);
    }
    const trend = Object.entries(dailyMap)
      .sort(([a],[b])=>a.localeCompare(b))
      .map(([date,rs]) => ({
        date, avg: Math.round(rs.reduce((a,b)=>a+b,0)/rs.length*10)/10, count:rs.length,
      }));

    res.json({
      period:       { days, since },
      total,        completed:completed.length, responseRate,
      avgRating:    Math.round(avg*10)/10,
      nps,
      distribution: dist,
      topTags:      Object.entries(tagCounts).sort(([,a],[,b])=>b-a).slice(0,8),
      trend,
    });
  } catch (e) { next(e); }
});

// GET /api/satisfaction?workspaceId=&status=&limit=
router.get("/", async (req, res, next) => {
  try {
    const { workspaceId, status, limit } = z.object({
      workspaceId: z.string().cuid(),
      status:      z.nativeEnum(SurveyStatus).optional(),
      limit:       z.coerce.number().default(50),
    }).parse(req.query);

    const surveys = await prisma.satisfactionSurvey.findMany({
      where:   { workspaceId, ...(status ? { status } : {}) },
      orderBy: { sentAt: "desc" },
      take:    Math.min(limit, 200),
    });
    res.json(surveys);
  } catch (e) { next(e); }
});

export default router;
