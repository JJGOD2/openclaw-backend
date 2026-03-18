// src/routes/prompt-versions.ts
import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/db/client";
import { requireAuth, AuthRequest } from "@/middleware/auth";
import { AppError } from "@/middleware/errorHandler";

const router = Router();
router.use(requireAuth);

// ── GET /api/prompt-versions/:agentId ────────────────────────
router.get("/:agentId", async (req, res, next) => {
  try {
    const versions = await prisma.promptVersion.findMany({
      where:   { agentId: req.params.agentId },
      orderBy: { version: "desc" },
    });
    res.json(versions);
  } catch (e) { next(e); }
});

// ── POST /api/prompt-versions/:agentId ───────────────────────
// Save current prompt as a new version
router.post("/:agentId", async (req: AuthRequest, res, next) => {
  try {
    const Schema = z.object({
      systemPrompt: z.string().min(1),
      replyStyle:   z.string().optional(),
      changelog:    z.string().max(500).optional(),
    });
    const body = Schema.safeParse(req.body);
    if (!body.success) throw new AppError(400, body.error.message);

    // Get next version number
    const latest = await prisma.promptVersion.findFirst({
      where:   { agentId: req.params.agentId },
      orderBy: { version: "desc" },
      select:  { version: true },
    });
    const nextVersion = (latest?.version ?? 0) + 1;

    // Create new version
    const version = await prisma.promptVersion.create({
      data: {
        agentId:      req.params.agentId,
        version:      nextVersion,
        systemPrompt: body.data.systemPrompt,
        replyStyle:   body.data.replyStyle ?? "friendly",
        changelog:    body.data.changelog,
        isActive:     true,
        createdBy:    req.userId,
      },
    });

    // Deactivate all other versions
    await prisma.promptVersion.updateMany({
      where: { agentId: req.params.agentId, id: { not: version.id } },
      data:  { isActive: false },
    });

    // Also update the agent's systemPrompt
    await prisma.agent.update({
      where: { id: req.params.agentId },
      data:  { systemPrompt: body.data.systemPrompt,
                replyStyle:   body.data.replyStyle ?? "friendly" },
    });

    res.status(201).json(version);
  } catch (e) { next(e); }
});

// ── POST /api/prompt-versions/:agentId/rollback/:versionId ───
// Roll back to a previous version
router.post("/:agentId/rollback/:versionId", async (req: AuthRequest, res, next) => {
  try {
    const target = await prisma.promptVersion.findUnique({
      where: { id: req.params.versionId },
    });
    if (!target || target.agentId !== req.params.agentId) {
      throw new AppError(404, "Version not found");
    }

    // Create a new version based on the rolled-back content
    const latest = await prisma.promptVersion.findFirst({
      where:   { agentId: req.params.agentId },
      orderBy: { version: "desc" },
      select:  { version: true },
    });

    const newVersion = await prisma.promptVersion.create({
      data: {
        agentId:      req.params.agentId,
        version:      (latest?.version ?? 0) + 1,
        systemPrompt: target.systemPrompt,
        replyStyle:   target.replyStyle,
        changelog:    `Rollback to v${target.version}`,
        isActive:     true,
        createdBy:    req.userId,
      },
    });

    // Deactivate others
    await prisma.promptVersion.updateMany({
      where: { agentId: req.params.agentId, id: { not: newVersion.id } },
      data:  { isActive: false },
    });

    // Update agent
    await prisma.agent.update({
      where: { id: req.params.agentId },
      data:  { systemPrompt: target.systemPrompt, replyStyle: target.replyStyle },
    });

    res.json(newVersion);
  } catch (e) { next(e); }
});

// ── GET /api/prompt-versions/:agentId/diff/:v1/:v2 ───────────
// Simple line-by-line diff between two versions
router.get("/:agentId/diff/:v1/:v2", async (req, res, next) => {
  try {
    const [ver1, ver2] = await Promise.all([
      prisma.promptVersion.findFirst({ where: { agentId: req.params.agentId, version: parseInt(req.params.v1) } }),
      prisma.promptVersion.findFirst({ where: { agentId: req.params.agentId, version: parseInt(req.params.v2) } }),
    ]);
    if (!ver1 || !ver2) throw new AppError(404, "Version not found");

    // Simple line diff
    const lines1 = ver1.systemPrompt.split("\n");
    const lines2 = ver2.systemPrompt.split("\n");
    const diff: { type: "same"|"add"|"remove"; line: string }[] = [];

    const maxLen = Math.max(lines1.length, lines2.length);
    for (let i = 0; i < maxLen; i++) {
      if (i >= lines1.length)     diff.push({ type: "add",    line: lines2[i] });
      else if (i >= lines2.length)diff.push({ type: "remove", line: lines1[i] });
      else if (lines1[i] === lines2[i]) diff.push({ type: "same", line: lines1[i] });
      else {
        diff.push({ type: "remove", line: lines1[i] });
        diff.push({ type: "add",    line: lines2[i] });
      }
    }

    res.json({ v1: ver1, v2: ver2, diff, totalChanges: diff.filter(d => d.type !== "same").length });
  } catch (e) { next(e); }
});

export default router;
