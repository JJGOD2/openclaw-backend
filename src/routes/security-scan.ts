// src/routes/security-scan.ts
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "@/middleware/auth";
import { runSecurityScan } from "@/services/security-scanner.service";

const router = Router();
router.use(requireAuth);

// POST /api/security-scan
router.post("/", async (req, res, next) => {
  try {
    const { workspaceId } = z.object({ workspaceId: z.string().cuid() }).parse(req.body);
    const result = await runSecurityScan(workspaceId);
    res.json(result);
  } catch (e) { next(e); }
});

export default router;
