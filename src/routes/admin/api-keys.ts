// src/routes/admin/api-keys.ts
import { Router } from "express";
import { z } from "zod";
import crypto from "crypto";
import { prisma } from "@/db/client";
import { requireAuth } from "@/middleware/auth";
import { AppError } from "@/middleware/errorHandler";
import { ApiKeyScope } from "@prisma/client";

const router = Router();
router.use(requireAuth);

function generateKey(): { raw: string; hash: string; prefix: string } {
  const bytes  = crypto.randomBytes(32).toString("hex");
  const raw    = `oc_live_${bytes}`;
  const hash   = crypto.createHash("sha256").update(raw).digest("hex");
  const prefix = raw.slice(0, 18) + "...";
  return { raw, hash, prefix };
}

// ── GET /api/admin/api-keys ──────────────────────────────────
router.get("/", async (req, res, next) => {
  try {
    const { workspaceId } = req.query;
    const keys = await prisma.apiKey.findMany({
      where: workspaceId ? { workspaceId: String(workspaceId) } : {},
      select: {
        id: true, name: true, keyPrefix: true, scope: true,
        allowedIps: true, expiresAt: true, lastUsedAt: true,
        usageCount: true, enabled: true, createdAt: true,
        // Never return keyHash
      },
      orderBy: { createdAt: "desc" },
    });
    res.json(keys);
  } catch (e) { next(e); }
});

// ── POST /api/admin/api-keys  — 新建 key（只回傳一次 raw key）
router.post("/", async (req, res, next) => {
  try {
    const Schema = z.object({
      workspaceId: z.string().cuid().optional().nullable(),
      name:        z.string().min(1).max(80),
      scope:       z.nativeEnum(ApiKeyScope).optional(),
      allowedIps:  z.array(z.string()).optional(),
      expiresAt:   z.string().datetime().optional(),
    });
    const body = Schema.safeParse(req.body);
    if (!body.success) throw new AppError(400, body.error.message);

    const { raw, hash, prefix } = generateKey();

    const key = await prisma.apiKey.create({
      data: {
        ...body.data,
        keyHash:  hash,
        keyPrefix: prefix,
        expiresAt: body.data.expiresAt ? new Date(body.data.expiresAt) : undefined,
      },
    });

    // Return raw key ONCE — never stored in DB
    res.status(201).json({ ...key, rawKey: raw });
  } catch (e) { next(e); }
});

// ── PATCH /api/admin/api-keys/:id ───────────────────────────
router.patch("/:id", async (req, res, next) => {
  try {
    const Schema = z.object({
      name:       z.string().optional(),
      enabled:    z.boolean().optional(),
      allowedIps: z.array(z.string()).optional(),
      expiresAt:  z.string().datetime().nullable().optional(),
    });
    const body = Schema.safeParse(req.body);
    if (!body.success) throw new AppError(400, body.error.message);
    const key = await prisma.apiKey.update({ where: { id: req.params.id }, data: body.data });
    res.json({ id: key.id, name: key.name, enabled: key.enabled, keyPrefix: key.keyPrefix });
  } catch (e) { next(e); }
});

// ── DELETE /api/admin/api-keys/:id ──────────────────────────
router.delete("/:id", async (req, res, next) => {
  try {
    await prisma.apiKey.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (e) { next(e); }
});

// ── API Key authentication middleware (for public API) ───────
export async function authenticateApiKey(
  req: import("express").Request,
  res: import("express").Response,
  next: import("express").NextFunction
) {
  const raw = req.headers["x-api-key"] as string | undefined;
  if (!raw) return res.status(401).json({ error: "API key required" });

  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  const key  = await prisma.apiKey.findUnique({ where: { keyHash: hash } });

  if (!key || !key.enabled) return res.status(401).json({ error: "Invalid or disabled API key" });
  if (key.expiresAt && key.expiresAt < new Date()) return res.status(401).json({ error: "API key expired" });

  // IP allowlist check
  if (key.allowedIps.length > 0) {
    const clientIp = req.ip ?? req.socket.remoteAddress ?? "";
    if (!key.allowedIps.includes(clientIp)) {
      return res.status(403).json({ error: "IP not in allowlist" });
    }
  }

  // Update last used
  await prisma.apiKey.update({
    where: { id: key.id },
    data:  { lastUsedAt: new Date(), usageCount: { increment: 1 } },
  }).catch(() => {});

  (req as express.Request & { apiKeyId: string; apiKeyScope: string }).apiKeyId    = key.id;
  (req as express.Request & { apiKeyId: string; apiKeyScope: string }).apiKeyScope = key.scope;
  next();
}

import express from "express";
export default router;
