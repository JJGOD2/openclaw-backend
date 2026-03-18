// src/routes/knowledge.ts
import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/db/client";
import { requireAuth } from "@/middleware/auth";
import { AppError } from "@/middleware/errorHandler";
import { processDocument, searchKnowledge } from "@/services/rag/rag.service";

const router = Router();
router.use(requireAuth);

// ── GET /api/knowledge?workspaceId= ──────────────────────────
router.get("/", async (req, res, next) => {
  try {
    const { workspaceId } = z.object({ workspaceId: z.string().cuid() }).parse(req.query);
    const kbs = await prisma.knowledgeBase.findMany({
      where:   { workspaceId },
      include: { _count: { select: { documents: true } } },
      orderBy: { createdAt: "desc" },
    });
    res.json(kbs);
  } catch (e) { next(e); }
});

// ── POST /api/knowledge ──────────────────────────────────────
router.post("/", async (req, res, next) => {
  try {
    const body = z.object({
      workspaceId: z.string().cuid(),
      name:        z.string().min(1).max(80),
      description: z.string().max(300).optional(),
      agentIds:    z.array(z.string().cuid()).optional(),
    }).parse(req.body);

    const kb = await prisma.knowledgeBase.create({ data: { ...body, agentIds: body.agentIds ?? [] } });
    res.status(201).json(kb);
  } catch (e) { next(e); }
});

// ── PATCH /api/knowledge/:id ─────────────────────────────────
router.patch("/:id", async (req, res, next) => {
  try {
    const body = z.object({
      name:        z.string().optional(),
      description: z.string().optional(),
      agentIds:    z.array(z.string().cuid()).optional(),
    }).parse(req.body);
    const kb = await prisma.knowledgeBase.update({ where: { id: req.params.id }, data: body });
    res.json(kb);
  } catch (e) { next(e); }
});

// ── DELETE /api/knowledge/:id ────────────────────────────────
router.delete("/:id", async (req, res, next) => {
  try {
    await prisma.knowledgeBase.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (e) { next(e); }
});

// ── GET /api/knowledge/:id/documents ─────────────────────────
router.get("/:id/documents", async (req, res, next) => {
  try {
    const docs = await prisma.kBDocument.findMany({
      where:   { kbId: req.params.id },
      select:  { id:true, title:true, type:true, status:true, wordCount:true,
                 sourceUrl:true, processedAt:true, createdAt:true,
                 _count: { select: { chunks: true } } },
      orderBy: { createdAt: "desc" },
    });
    res.json(docs);
  } catch (e) { next(e); }
});

// ── POST /api/knowledge/:id/documents ────────────────────────
router.post("/:id/documents", async (req, res, next) => {
  try {
    const Schema = z.object({
      title:      z.string().min(1).max(200),
      type:       z.enum(["TEXT","MARKDOWN","FAQ","URL","FILE"]).default("TEXT"),
      content:    z.string().min(10).max(500_000),
      sourceUrl:  z.string().url().optional(),
    });
    const body = Schema.safeParse(req.body);
    if (!body.success) throw new AppError(400, body.error.message);

    const kb = await prisma.knowledgeBase.findUnique({ where: { id: req.params.id } });
    if (!kb) throw new AppError(404, "Knowledge base not found");

    const doc = await prisma.kBDocument.create({
      data: {
        kbId:       req.params.id,
        title:      body.data.title,
        type:       body.data.type as never,
        rawContent: body.data.content,
        sourceUrl:  body.data.sourceUrl,
        status:     "PENDING",
      },
    });

    // Update doc count
    await prisma.knowledgeBase.update({
      where: { id: req.params.id },
      data:  { docCount: { increment: 1 } },
    });

    // Process asynchronously (don't wait)
    processDocument(doc.id).catch(err =>
      console.error(`[KB] Process failed for doc ${doc.id}:`, err.message)
    );

    res.status(201).json({ ...doc, message: "文件已上傳，正在處理中..." });
  } catch (e) { next(e); }
});

// ── DELETE /api/knowledge/documents/:docId ───────────────────
router.delete("/documents/:docId", async (req, res, next) => {
  try {
    const doc = await prisma.kBDocument.findUnique({
      where: { id: req.params.docId }, include: { kb: true },
    });
    if (!doc) throw new AppError(404, "Document not found");

    const chunkCount = await prisma.kBChunk.count({ where: { docId: doc.id } });
    await prisma.kBDocument.delete({ where: { id: doc.id } });
    await prisma.knowledgeBase.update({
      where: { id: doc.kbId },
      data:  { docCount:  { decrement: 1 },
               chunkCount:{ decrement: chunkCount } },
    });
    res.status(204).end();
  } catch (e) { next(e); }
});

// ── POST /api/knowledge/:id/search ───────────────────────────
router.post("/:id/search", async (req, res, next) => {
  try {
    const { query, topK } = z.object({
      query: z.string().min(1),
      topK:  z.number().min(1).max(10).default(5),
    }).parse(req.body);

    const results = await searchKnowledge([req.params.id], query, topK);
    res.json({ results, count: results.length });
  } catch (e) { next(e); }
});

// ── POST /api/knowledge/:id/reprocess ────────────────────────
router.post("/:id/reprocess", async (req, res, next) => {
  try {
    const { docId } = z.object({ docId: z.string().cuid() }).parse(req.body);
    await prisma.kBDocument.update({
      where: { id: docId }, data: { status: "PENDING", errorMessage: null },
    });
    processDocument(docId).catch(err =>
      console.error(`[KB] Reprocess failed for ${docId}:`, err.message)
    );
    res.json({ ok: true, message: "已重新排入處理佇列" });
  } catch (e) { next(e); }
});

export default router;
