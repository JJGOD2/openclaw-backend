// src/routes/secrets.ts
import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/db/client";
import { requireAuth } from "@/middleware/auth";
import { AppError } from "@/middleware/errorHandler";
import { encryptSecret, maskSecret } from "@/lib/crypto";
import { SecretStatus } from "@prisma/client";

const router = Router();
router.use(requireAuth);

// GET /api/secrets?workspaceId=xxx  — 遮罩顯示，不回傳明文
router.get("/", async (req, res, next) => {
  try {
    const { workspaceId } = req.query;
    if (!workspaceId) throw new AppError(400, "workspaceId required");

    const secrets = await prisma.secret.findMany({
      where:   { workspaceId: String(workspaceId) },
      orderBy: { name: "asc" },
    });

    res.json(
      secrets.map((s) => ({
        id:           s.id,
        name:         s.name,
        maskedValue:  maskSecret("sk-...placeholder"),   // 不回傳 encryptedValue
        status:       s.status,
        expiresAt:    s.expiresAt,
        lastUpdatedAt:s.lastUpdatedAt,
      }))
    );
  } catch (e) { next(e); }
});

// POST /api/secrets  — 新增 or 更新 secret
router.post("/", async (req, res, next) => {
  try {
    const Schema = z.object({
      workspaceId: z.string().cuid(),
      name:        z.string().min(1).max(80),
      value:       z.string().min(1),              // 明文，儲存前加密
      expiresAt:   z.string().datetime().optional(),
    });
    const body = Schema.safeParse(req.body);
    if (!body.success) throw new AppError(400, body.error.message);

    const { workspaceId, name, value, expiresAt } = body.data;
    const encrypted = encryptSecret(value);

    // Check expiry to set status
    let status: SecretStatus = "OK";
    if (expiresAt) {
      const diff = new Date(expiresAt).getTime() - Date.now();
      const thirtyDays = 30 * 24 * 60 * 60 * 1000;
      if (diff < 0)          status = "EXPIRED";
      else if (diff < thirtyDays) status = "EXPIRING";
    }

    const secret = await prisma.secret.upsert({
      where:  { workspaceId_name: { workspaceId, name } },
      update: { encryptedValue: encrypted, lastUpdatedAt: new Date(), status,
                expiresAt: expiresAt ? new Date(expiresAt) : undefined },
      create: { workspaceId, name, encryptedValue: encrypted, status,
                expiresAt: expiresAt ? new Date(expiresAt) : undefined },
    });

    res.status(201).json({ id: secret.id, name: secret.name, status: secret.status });
  } catch (e) { next(e); }
});

// DELETE /api/secrets/:id
router.delete("/:id", async (req, res, next) => {
  try {
    await prisma.secret.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (e) { next(e); }
});

export default router;
