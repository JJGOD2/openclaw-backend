// src/routes/tools.ts
import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/db/client";
import { requireAuth } from "@/middleware/auth";
import { AppError } from "@/middleware/errorHandler";
import { RiskLevel, SkillSource, SkillStatus } from "@prisma/client";

const router = Router();
router.use(requireAuth);

// ── TOOLS ────────────────────────────────────────────────────

// GET /api/tools?workspaceId=xxx
router.get("/", async (req, res, next) => {
  try {
    const { workspaceId } = req.query;
    if (!workspaceId) throw new AppError(400, "workspaceId required");

    const wt = await prisma.workspaceTool.findMany({
      where:   { workspaceId: String(workspaceId) },
      include: { tool: true },
    });

    res.json(
      wt.map(({ tool, enabled, execCount }) => ({
        id:             tool.id,
        name:           tool.name,
        risk:           tool.risk,
        requireApproval:tool.requireApproval,
        enabled,
        execCount,
      }))
    );
  } catch (e) { next(e); }
});

// POST /api/tools  — create global tool definition
router.post("/", async (req, res, next) => {
  try {
    const Schema = z.object({
      name:           z.string().min(1),
      description:    z.string().optional(),
      risk:           z.nativeEnum(RiskLevel).optional(),
      requireApproval:z.boolean().optional(),
    });
    const body = Schema.safeParse(req.body);
    if (!body.success) throw new AppError(400, body.error.message);
    const tool = await prisma.tool.create({ data: body.data });
    res.status(201).json(tool);
  } catch (e) { next(e); }
});

// PATCH /api/tools/:workspaceId/:toolId/toggle
router.patch("/:workspaceId/:toolId/toggle", async (req, res, next) => {
  try {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    const wt = await prisma.workspaceTool.upsert({
      where: {
        workspaceId_toolId: { workspaceId: req.params.workspaceId, toolId: req.params.toolId },
      },
      update: { enabled },
      create: { workspaceId: req.params.workspaceId, toolId: req.params.toolId, enabled },
    });
    res.json(wt);
  } catch (e) { next(e); }
});

// POST /api/tools/:workspaceId/:toolId/exec  — increment exec counter
router.post("/:workspaceId/:toolId/exec", async (req, res, next) => {
  try {
    const wt = await prisma.workspaceTool.update({
      where: {
        workspaceId_toolId: { workspaceId: req.params.workspaceId, toolId: req.params.toolId },
      },
      data: { execCount: { increment: 1 } },
    });
    res.json(wt);
  } catch (e) { next(e); }
});

// ── SKILLS ───────────────────────────────────────────────────

// GET /api/tools/skills?workspaceId=xxx
router.get("/skills", async (req, res, next) => {
  try {
    const { workspaceId } = req.query;
    if (!workspaceId) throw new AppError(400, "workspaceId required");

    const ws = await prisma.workspaceSkill.findMany({
      where:   { workspaceId: String(workspaceId) },
      include: { skill: true },
    });

    res.json(
      ws.map(({ skill, status, reviewedAt }) => ({
        id:         skill.id,
        name:       skill.name,
        version:    skill.version,
        risk:       skill.risk,
        source:     skill.source,
        status,
        reviewedAt,
      }))
    );
  } catch (e) { next(e); }
});

// POST /api/tools/skills — install skill for workspace
router.post("/skills", async (req, res, next) => {
  try {
    const Schema = z.object({
      workspaceId: z.string().cuid(),
      name:        z.string().min(1),
      version:     z.string().min(1),
      risk:        z.nativeEnum(RiskLevel).optional(),
      source:      z.nativeEnum(SkillSource).optional(),
    });
    const body = Schema.safeParse(req.body);
    if (!body.success) throw new AppError(400, body.error.message);

    const { workspaceId, ...skillData } = body.data;
    const skill = await prisma.skill.upsert({
      where:  { name: skillData.name },
      update: { version: skillData.version },
      create: skillData,
    });

    const ws = await prisma.workspaceSkill.upsert({
      where:  { workspaceId_skillId: { workspaceId, skillId: skill.id } },
      update: {},
      create: { workspaceId, skillId: skill.id },
    });

    res.status(201).json(ws);
  } catch (e) { next(e); }
});

// PATCH /api/tools/skills/:workspaceId/:skillId/review
router.patch("/skills/:workspaceId/:skillId/review", async (req, res, next) => {
  try {
    const { status } = z.object({ status: z.nativeEnum(SkillStatus) }).parse(req.body);
    const ws = await prisma.workspaceSkill.update({
      where: { workspaceId_skillId: { workspaceId: req.params.workspaceId, skillId: req.params.skillId } },
      data:  { status, reviewedAt: new Date() },
    });
    res.json(ws);
  } catch (e) { next(e); }
});

export default router;
