// src/routes/feature-flags.ts
import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireAdmin } from "@/middleware/auth";
import { listFlags, setFlagOverride, FLAGS } from "@/lib/flags/feature-flags";
import { AppError } from "@/middleware/errorHandler";

const router = Router();
router.use(requireAuth);

// GET /api/flags?workspaceId=
router.get("/", async (req, res, next) => {
  try {
    const { workspaceId } = z.object({ workspaceId: z.string().cuid() }).parse(req.query);
    const flags = await listFlags(workspaceId);
    res.json(flags);
  } catch (e) { next(e); }
});

// GET /api/flags/definitions — all defined flags (admin)
router.get("/definitions", requireAdmin, (_req, res) => {
  res.json(Object.values(FLAGS));
});

// PATCH /api/flags/:flagKey — set override (admin only)
router.patch("/:flagKey", requireAdmin, async (req, res, next) => {
  try {
    const { workspaceId, enabled } = z.object({
      workspaceId: z.string().cuid(),
      enabled:     z.boolean(),
    }).parse(req.body);

    if (!FLAGS[req.params.flagKey]) {
      throw new AppError(404, `Unknown flag: ${req.params.flagKey}`);
    }

    await setFlagOverride(req.params.flagKey, workspaceId, enabled);
    res.json({ ok: true, flagKey: req.params.flagKey, workspaceId, enabled });
  } catch (e) { next(e); }
});

export default router;
