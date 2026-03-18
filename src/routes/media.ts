// src/routes/media.ts
import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/db/client";
import { requireAuth } from "@/middleware/auth";
import { AppError } from "@/middleware/errorHandler";
import {
  detectLanguage, translateText, transcribeAudio,
  autoTranslateIfNeeded, SUPPORTED_LANGS,
} from "@/services/media/translate.service";

const router = Router();
router.use(requireAuth);

// GET /api/media/languages — supported languages list
router.get("/languages", (_req, res) =>
  res.json(Object.entries(SUPPORTED_LANGS).map(([code, name]) => ({ code, name })))
);

// POST /api/media/detect
router.post("/detect", async (req, res, next) => {
  try {
    const { text } = z.object({ text: z.string().min(1) }).parse(req.body);
    const code     = await detectLanguage(text);
    res.json({ code, name: SUPPORTED_LANGS[code] ?? code });
  } catch (e) { next(e); }
});

// POST /api/media/translate
router.post("/translate", async (req, res, next) => {
  try {
    const { text, targetLang, sourceLang } = z.object({
      text:       z.string().min(1).max(10_000),
      targetLang: z.string().min(2),
      sourceLang: z.string().optional(),
    }).parse(req.body);

    const startMs    = Date.now();
    const translated = await translateText(text, targetLang, sourceLang);
    res.json({
      original:   text,
      translated,
      targetLang,
      sourceLang: sourceLang ?? (await detectLanguage(text)),
      latencyMs:  Date.now() - startMs,
    });
  } catch (e) { next(e); }
});

// POST /api/media/auto-translate
router.post("/auto-translate", async (req, res, next) => {
  try {
    const { text, targetLang } = z.object({
      text:       z.string().min(1),
      targetLang: z.string().min(2),
    }).parse(req.body);

    const result = await autoTranslateIfNeeded(text, targetLang);
    res.json(result);
  } catch (e) { next(e); }
});

// POST /api/media/transcribe
router.post("/transcribe", async (req, res, next) => {
  try {
    const { workspaceId, audioUrl, sessionId } = z.object({
      workspaceId: z.string().cuid(),
      audioUrl:    z.string().url(),
      sessionId:   z.string().optional(),
    }).parse(req.body);

    const result = await transcribeAudio(audioUrl, workspaceId, sessionId);
    res.json(result);
  } catch (e) { next(e); }
});

// GET /api/media/jobs/:jobId — poll transcription job status
router.get("/jobs/:jobId", async (req, res, next) => {
  try {
    const job = await prisma.mediaJob.findUnique({ where: { id: req.params.jobId } });
    if (!job) throw new AppError(404, "Job not found");
    res.json({
      id:         job.id,
      status:     job.status,
      transcript: job.transcript,
      language:   job.language,
      errorMsg:   job.errorMsg,
    });
  } catch (e) { next(e); }
});

// GET /api/media/jobs?workspaceId=&status=
router.get("/jobs", async (req, res, next) => {
  try {
    const { workspaceId, status } = z.object({
      workspaceId: z.string().cuid(),
      status:      z.string().optional(),
    }).parse(req.query);

    const jobs = await prisma.mediaJob.findMany({
      where:   { workspaceId, ...(status ? { status: status as never } : {}) },
      orderBy: { createdAt: "desc" },
      take:    50,
    });
    res.json(jobs);
  } catch (e) { next(e); }
});

export default router;
