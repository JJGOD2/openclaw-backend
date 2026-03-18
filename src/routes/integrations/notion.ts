// src/routes/integrations/notion.ts
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "@/middleware/auth";
import { AppError } from "@/middleware/errorHandler";
import {
  notionSearch,
  notionQueryDatabase,
  notionCreatePage,
  notionAppendBlocks,
  notionParagraph,
} from "@/services/notion.service";

const router = Router();
router.use(requireAuth);

// POST /api/integrations/notion/search
router.post("/search", async (req, res, next) => {
  try {
    const { workspaceId, query, filter } = z.object({
      workspaceId: z.string().cuid(),
      query:       z.string(),
      filter:      z.enum(["page","database"]).optional(),
    }).parse(req.body);
    const results = await notionSearch(workspaceId, query, filter);
    res.json(results);
  } catch (e) { next(e); }
});

// POST /api/integrations/notion/query
router.post("/query", async (req, res, next) => {
  try {
    const { workspaceId, databaseId, filter, pageSize } = z.object({
      workspaceId: z.string().cuid(),
      databaseId:  z.string().min(1),
      filter:      z.record(z.unknown()).optional(),
      pageSize:    z.number().optional(),
    }).parse(req.body);
    const rows = await notionQueryDatabase(workspaceId, databaseId, filter, pageSize);
    res.json({ rows, count: rows.length });
  } catch (e) { next(e); }
});

// POST /api/integrations/notion/create-page
router.post("/create-page", async (req, res, next) => {
  try {
    const { workspaceId, databaseId, properties, content } = z.object({
      workspaceId: z.string().cuid(),
      databaseId:  z.string().min(1),
      properties:  z.record(z.unknown()),
      content:     z.string().optional(),
    }).parse(req.body);

    const page = await notionCreatePage(
      workspaceId, databaseId, properties,
      content ? [notionParagraph(content)] : undefined
    );
    res.status(201).json(page);
  } catch (e) { next(e); }
});

// POST /api/integrations/notion/append
router.post("/append", async (req, res, next) => {
  try {
    const { workspaceId, pageId, text } = z.object({
      workspaceId: z.string().cuid(),
      pageId:      z.string().min(1),
      text:        z.string().min(1),
    }).parse(req.body);
    await notionAppendBlocks(workspaceId, pageId, [notionParagraph(text)]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
