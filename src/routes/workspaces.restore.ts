// src/routes/workspaces.restore.ts
// 掛在 /api/workspaces/:id/backups/:backupId/restore
import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/db/client";
import { requireAuth } from "@/middleware/auth";
import { AppError } from "@/middleware/errorHandler";
import { restoreWorkspace } from "@/services/restore.service";

const router = Router({ mergeParams: true });
router.use(requireAuth);

// POST /api/workspaces/:id/backups/:backupId/restore
router.post("/:backupId/restore", async (req, res, next) => {
  try {
    const { backupId } = z.object({ backupId: z.string().cuid() }).parse(req.params);

    const Schema = z.object({
      targetWorkspaceId: z.string().cuid().optional(),
      overwrite:         z.boolean().optional(),
      skipSecrets:       z.boolean().optional(),
      newWorkspaceName:  z.string().max(80).optional(),
    });
    const opts = Schema.safeParse(req.body);
    if (!opts.success) throw new AppError(400, opts.error.message);

    const result = await restoreWorkspace(backupId, opts.data.targetWorkspaceId, opts.data);
    res.json(result);
  } catch (e) { next(e); }
});

// GET /api/workspaces/:id/backups/:backupId/preview
// 預覽備份內容（不執行還原）
router.get("/:backupId/preview", async (req, res, next) => {
  try {
    const backup = await prisma.workspaceBackup.findUnique({
      where: { id: req.params.backupId },
    });
    if (!backup) throw new AppError(404, "Backup not found");

    const snap = backup.snapshotJson as Record<string, unknown>;
    const agents   = (snap.agents   as unknown[] ?? []).length;
    const channels = (snap.channels as unknown[] ?? []).length;
    const tools    = (snap.tools    as unknown[] ?? []).length;
    const skills   = (snap.skills   as unknown[] ?? []).length;
    const secrets  = (snap.secrets  as unknown[] ?? []).length;

    res.json({
      backupId:   backup.id,
      note:       backup.note,
      createdAt:  backup.createdAt,
      workspaceId:backup.workspaceId,
      summary: { agents, channels, tools, skills, secrets },
      snapshot: snap,
    });
  } catch (e) { next(e); }
});

export default router;
