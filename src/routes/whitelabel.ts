// src/routes/whitelabel.ts
import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/db/client";
import { requireAuth, requireAdmin } from "@/middleware/auth";
import { AppError } from "@/middleware/errorHandler";

const router = Router();

const Schema = z.object({
  workspaceId:  z.string().cuid().optional().nullable(),
  brandName:    z.string().min(1).max(80).optional(),
  logoUrl:      z.string().url().optional().nullable(),
  faviconUrl:   z.string().url().optional().nullable(),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  accentColor:  z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  customDomain: z.string().optional().nullable(),
  customCss:    z.string().max(20000).optional().nullable(),
  supportEmail: z.string().email().optional().nullable(),
  supportUrl:   z.string().url().optional().nullable(),
  footerText:   z.string().max(200).optional().nullable(),
  hideBuiltBy:  z.boolean().optional(),
});

// GET /api/whitelabel?workspaceId= (public — used by frontend theme loader)
router.get("/", async (req, res, next) => {
  try {
    const { workspaceId } = req.query;
    const brand = await prisma.whiteLabel.findFirst({
      where: workspaceId
        ? { OR: [{ workspaceId: String(workspaceId) }, { workspaceId: null }] }
        : { workspaceId: null },
      orderBy: { workspaceId: "asc" },   // workspace-specific wins over global
    });
    res.json(brand ?? {
      brandName:    "OpenClaw Console",
      primaryColor: "#BA7517",
      accentColor:  "#854F0B",
      hideBuiltBy:  false,
    });
  } catch (e) { next(e); }
});

// GET /api/whitelabel/all  (admin)
router.get("/all", requireAdmin, async (_req, res, next) => {
  try {
    const all = await prisma.whiteLabel.findMany({ orderBy: { createdAt: "desc" } });
    res.json(all);
  } catch (e) { next(e); }
});

// POST /api/whitelabel  (upsert)
router.post("/", requireAuth, async (req, res, next) => {
  try {
    const body = Schema.safeParse(req.body);
    if (!body.success) throw new AppError(400, body.error.message);
    const { workspaceId, ...data } = body.data;

    const brand = await prisma.whiteLabel.upsert({
      where:  workspaceId ? { workspaceId } : { id: "global" },
      update: data,
      create: { ...data, workspaceId: workspaceId ?? null },
    });
    res.json(brand);
  } catch (e) { next(e); }
});

// DELETE /api/whitelabel/:id  (admin)
router.delete("/:id", requireAdmin, async (req, res, next) => {
  try {
    await prisma.whiteLabel.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (e) { next(e); }
});

export default router;
