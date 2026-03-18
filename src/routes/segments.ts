// src/routes/segments.ts
import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/db/client";
import { requireAuth } from "@/middleware/auth";
import { AppError } from "@/middleware/errorHandler";

const router = Router();
router.use(requireAuth);

// GET /api/segments?workspaceId=
router.get("/", async (req, res, next) => {
  try {
    const { workspaceId } = z.object({ workspaceId: z.string().cuid() }).parse(req.query);
    const segments = await prisma.userSegment.findMany({
      where:   { workspaceId },
      include: { _count: { select: { tags: true } } },
      orderBy: { createdAt: "desc" },
    });
    res.json(segments);
  } catch (e) { next(e); }
});

// POST /api/segments
router.post("/", async (req, res, next) => {
  try {
    const body = z.object({
      workspaceId: z.string().cuid(),
      name:        z.string().min(1).max(80),
      description: z.string().optional(),
      color:       z.string().optional(),
      rules:       z.array(z.record(z.unknown())).default([]),
    }).parse(req.body);
    const seg = await prisma.userSegment.create({ data: body });
    res.status(201).json(seg);
  } catch (e) { next(e); }
});

// DELETE /api/segments/:id
router.delete("/:id", async (req, res, next) => {
  try {
    await prisma.userSegment.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (e) { next(e); }
});

// ── Tags ──────────────────────────────────────────────────────

// GET /api/segments/tags?workspaceId=&platform=&userId=
router.get("/tags", async (req, res, next) => {
  try {
    const { workspaceId, platform, userId } = z.object({
      workspaceId: z.string().cuid(),
      platform:    z.string().optional(),
      userId:      z.string().optional(),
    }).parse(req.query);

    const tags = await prisma.userTag.findMany({
      where: {
        workspaceId,
        ...(platform ? { platform } : {}),
        ...(userId   ? { userId }   : {}),
      },
      orderBy: { updatedAt: "desc" },
      take:    200,
    });
    res.json(tags);
  } catch (e) { next(e); }
});

// POST /api/segments/tags — upsert user tags
router.post("/tags", async (req, res, next) => {
  try {
    const body = z.object({
      workspaceId: z.string().cuid(),
      userId:      z.string().min(1),
      platform:    z.string().min(1),
      tags:        z.array(z.string()),
      segmentId:   z.string().cuid().optional(),
      metadata:    z.record(z.unknown()).optional(),
    }).parse(req.body);

    const tag = await prisma.userTag.upsert({
      where:  { workspaceId_platform_userId: {
        workspaceId: body.workspaceId,
        platform:    body.platform,
        userId:      body.userId,
      }},
      update: { tags: body.tags, segmentId: body.segmentId, metadata: body.metadata ?? {} },
      create: { ...body, metadata: body.metadata ?? {} },
    });
    res.json(tag);
  } catch (e) { next(e); }
});

// PATCH /api/segments/tags/:id/add-tag — add a single tag
router.patch("/tags/:id/add-tag", async (req, res, next) => {
  try {
    const { tag } = z.object({ tag: z.string().min(1) }).parse(req.body);
    const existing = await prisma.userTag.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new AppError(404, "UserTag not found");

    const tags = Array.from(new Set([...existing.tags, tag]));
    const updated = await prisma.userTag.update({
      where: { id: req.params.id }, data: { tags },
    });
    res.json(updated);
  } catch (e) { next(e); }
});

// PATCH /api/segments/tags/:id/remove-tag
router.patch("/tags/:id/remove-tag", async (req, res, next) => {
  try {
    const { tag } = z.object({ tag: z.string().min(1) }).parse(req.body);
    const existing = await prisma.userTag.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new AppError(404, "UserTag not found");

    const updated = await prisma.userTag.update({
      where: { id: req.params.id },
      data:  { tags: existing.tags.filter(t => t !== tag) },
    });
    res.json(updated);
  } catch (e) { next(e); }
});

// GET /api/segments/:id/members — list all users in a segment
router.get("/:id/members", async (req, res, next) => {
  try {
    const members = await prisma.userTag.findMany({
      where:   { segmentId: req.params.id },
      orderBy: { updatedAt: "desc" },
    });
    res.json({ members, count: members.length });
  } catch (e) { next(e); }
});

export default router;
