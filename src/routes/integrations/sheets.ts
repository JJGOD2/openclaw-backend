// src/routes/integrations/sheets.ts
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "@/middleware/auth";
import { AppError } from "@/middleware/errorHandler";
import { sheetsRead, sheetsAppend, sheetsWrite } from "@/services/sheets.service";

const router = Router();
router.use(requireAuth);

// GET /api/integrations/sheets/read
router.post("/read", async (req, res, next) => {
  try {
    const { workspaceId, spreadsheetId, range } = z.object({
      workspaceId:   z.string().cuid(),
      spreadsheetId: z.string().min(1),
      range:         z.string().min(1),
    }).parse(req.body);

    const values = await sheetsRead(workspaceId, spreadsheetId, range);
    res.json({ values, rowCount: values.length });
  } catch (e) { next(e); }
});

// POST /api/integrations/sheets/append
router.post("/append", async (req, res, next) => {
  try {
    const { workspaceId, spreadsheetId, range, values } = z.object({
      workspaceId:   z.string().cuid(),
      spreadsheetId: z.string().min(1),
      range:         z.string().min(1),
      values:        z.array(z.array(z.union([z.string(), z.number()]))),
    }).parse(req.body);

    const result = await sheetsAppend(workspaceId, spreadsheetId, range, values);
    res.json(result);
  } catch (e) { next(e); }
});

// POST /api/integrations/sheets/write
router.post("/write", async (req, res, next) => {
  try {
    const { workspaceId, spreadsheetId, range, values } = z.object({
      workspaceId:   z.string().cuid(),
      spreadsheetId: z.string().min(1),
      range:         z.string().min(1),
      values:        z.array(z.array(z.union([z.string(), z.number()]))),
    }).parse(req.body);

    const result = await sheetsWrite(workspaceId, spreadsheetId, range, values);
    res.json(result);
  } catch (e) { next(e); }
});

export default router;
