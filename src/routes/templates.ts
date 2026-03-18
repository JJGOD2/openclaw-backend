// src/routes/templates.ts
import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/db/client";
import { requireAuth } from "@/middleware/auth";
import { AppError } from "@/middleware/errorHandler";
import { TemplateCategory } from "@prisma/client";

const router = Router();
router.use(requireAuth);

const TemplateSchema = z.object({
  workspaceId: z.string().cuid().optional().nullable(),
  name:        z.string().min(1).max(80),
  description: z.string().max(300).optional(),
  category:    z.nativeEnum(TemplateCategory).optional(),
  content:     z.string().min(1),
  variables:   z.array(z.object({
    name:        z.string(),
    description: z.string().optional(),
    default:     z.string().optional(),
  })).optional(),
});

// GET /api/templates?workspaceId=  — system + workspace templates
router.get("/", async (req, res, next) => {
  try {
    const { workspaceId, category } = req.query;
    const templates = await prisma.template.findMany({
      where: {
        OR: [
          { isSystem: true },
          ...(workspaceId ? [{ workspaceId: String(workspaceId) }] : []),
        ],
        ...(category ? { category: category as TemplateCategory } : {}),
      },
      orderBy: [{ isSystem: "desc" }, { usageCount: "desc" }, { createdAt: "desc" }],
    });
    res.json(templates);
  } catch (e) { next(e); }
});

// POST /api/templates
router.post("/", async (req, res, next) => {
  try {
    const body = TemplateSchema.safeParse(req.body);
    if (!body.success) throw new AppError(400, body.error.message);
    const t = await prisma.template.create({ data: body.data });
    res.status(201).json(t);
  } catch (e) { next(e); }
});

// PATCH /api/templates/:id
router.patch("/:id", async (req, res, next) => {
  try {
    const body = TemplateSchema.partial().safeParse(req.body);
    if (!body.success) throw new AppError(400, body.error.message);
    const existing = await prisma.template.findUnique({ where: { id: req.params.id } });
    if (!existing)            throw new AppError(404, "Template not found");
    if (existing.isSystem)    throw new AppError(403, "System templates cannot be modified");
    const t = await prisma.template.update({ where: { id: req.params.id }, data: body.data });
    res.json(t);
  } catch (e) { next(e); }
});

// DELETE /api/templates/:id
router.delete("/:id", async (req, res, next) => {
  try {
    const existing = await prisma.template.findUnique({ where: { id: req.params.id } });
    if (!existing)         throw new AppError(404, "Template not found");
    if (existing.isSystem) throw new AppError(403, "System templates cannot be deleted");
    await prisma.template.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (e) { next(e); }
});

// POST /api/templates/:id/use — apply template vars + increment counter
router.post("/:id/use", async (req, res, next) => {
  try {
    const t = await prisma.template.findUnique({ where: { id: req.params.id } });
    if (!t) throw new AppError(404, "Template not found");

    const vars: Record<string, string> = req.body.variables ?? {};
    let rendered = t.content;
    for (const [k, v] of Object.entries(vars)) {
      rendered = rendered.replaceAll(`{{${k}}}`, v);
    }

    await prisma.template.update({
      where: { id: req.params.id },
      data:  { usageCount: { increment: 1 } },
    });

    res.json({ rendered, original: t.content });
  } catch (e) { next(e); }
});

export default router;
