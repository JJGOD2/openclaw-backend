// src/routes/marketplace.ts
import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/db/client";
import { requireAuth, AuthRequest } from "@/middleware/auth";
import { AppError } from "@/middleware/errorHandler";
import { restoreWorkspace } from "@/services/restore.service";

const router = Router();

// GET /api/marketplace?category=&q= (public browse)
router.get("/", async (req, res, next) => {
  try {
    const { category, q, limit } = z.object({
      category: z.string().optional(),
      q:        z.string().optional(),
      limit:    z.coerce.number().max(50).default(20),
    }).parse(req.query);

    const templates = await prisma.marketplaceTemplate.findMany({
      where: {
        ...(category ? { category: category.toUpperCase() as never } : {}),
        ...(q ? {
          OR: [
            { name:       { contains: q, mode: "insensitive" } },
            { description:{ contains: q, mode: "insensitive" } },
            { tags:       { has: q.toLowerCase() } },
          ],
        } : {}),
      },
      orderBy: [{ isOfficial: "desc" }, { installCount: "desc" }],
      take:    limit,
    });
    res.json(templates);
  } catch (e) { next(e); }
});

// POST /api/marketplace/publish — publish workspace as template
router.post("/publish", requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const body = z.object({
      workspaceId: z.string().cuid(),
      name:        z.string().min(1).max(100),
      description: z.string().min(10).max(1000),
      category:    z.enum(["ECOMMERCE","REAL_ESTATE","HEALTHCARE","FINANCE","EDUCATION","HOSPITALITY","GENERAL"]),
      tags:        z.array(z.string().max(30)).max(10).default([]),
    }).parse(req.body);

    // Build sanitized snapshot (no secrets)
    const ws = await prisma.workspace.findUnique({
      where:   { id: body.workspaceId },
      include: {
        agents:   { include: { toolBindings: true, promptTemplates: true } },
        tools:    { include: { tool: true } },
        skills:   true,
      },
    });
    if (!ws) throw new AppError(404, "Workspace not found");

    const preview = {
      name:   ws.name,
      client: "範例",
      plan:   ws.plan,
      agents: ws.agents.map(a => ({
        name: a.name, role: a.role, description: a.description,
        systemPromptPreview: a.systemPrompt?.slice(0, 200) + (a.systemPrompt?.length > 200 ? "…" : ""),
      })),
      toolCount:  ws.tools.length,
      skillCount: ws.skills.length,
    };

    const template = await prisma.marketplaceTemplate.create({
      data: {
        publishedBy:  req.userId!,
        name:         body.name,
        description:  body.description,
        category:     body.category as never,
        tags:         body.tags,
        previewJson:  preview,
      },
    });
    res.status(201).json(template);
  } catch (e) { next(e); }
});

// POST /api/marketplace/:id/install — install template to workspace
router.post("/:id/install", requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const { targetWorkspaceId, newWorkspaceName } = z.object({
      targetWorkspaceId: z.string().cuid().optional(),
      newWorkspaceName:  z.string().max(80).optional(),
    }).parse(req.body);

    const template = await prisma.marketplaceTemplate.findUnique({ where: { id: req.params.id } });
    if (!template) throw new AppError(404, "Template not found");

    // Note: In production, you'd store a full backup snapshot in the template
    // For now we create a skeleton workspace with the preview data
    const preview = template.previewJson as { name:string; agents:{name:string;role:string;description:string;systemPromptPreview:string}[] };

    const ws = await prisma.workspace.create({
      data: {
        name:   newWorkspaceName ?? `${template.name} (已安裝)`,
        client: newWorkspaceName ?? template.name,
        plan:   "STARTER",
        status: "SETTING",
      },
    });

    // Create agents from template
    for (const a of preview.agents ?? []) {
      await prisma.agent.create({
        data: {
          workspaceId:  ws.id,
          name:         a.name,
          initials:     a.name.slice(0, 2),
          role:         a.role,
          description:  a.description,
          systemPrompt: a.systemPromptPreview,
          status:       "DISABLED",
        },
      });
    }

    // Increment install count
    await prisma.marketplaceTemplate.update({
      where: { id: req.params.id },
      data:  { installCount: { increment: 1 } },
    });

    res.status(201).json({ workspaceId: ws.id, name: ws.name });
  } catch (e) { next(e); }
});

// POST /api/marketplace/:id/rate
router.post("/:id/rate", requireAuth, async (req, res, next) => {
  try {
    const { rating } = z.object({ rating: z.number().min(1).max(5) }).parse(req.body);
    const t = await prisma.marketplaceTemplate.findUnique({ where: { id: req.params.id } });
    if (!t) throw new AppError(404, "Not found");

    const newCount  = t.ratingCount + 1;
    const newRating = (t.rating * t.ratingCount + rating) / newCount;

    await prisma.marketplaceTemplate.update({
      where: { id: req.params.id },
      data:  { rating: newRating, ratingCount: newCount },
    });
    res.json({ ok: true, rating: newRating });
  } catch (e) { next(e); }
});

export default router;
