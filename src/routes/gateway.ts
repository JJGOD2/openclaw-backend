// src/routes/gateway.ts
import { Router } from "express";
import { prisma } from "@/db/client";
import { requireAuth } from "@/middleware/auth";
import { AppError } from "@/middleware/errorHandler";
import {
  buildGatewayConfig,
  validateConfig,
  pushConfigToGateway,
} from "@/services/gateway.service";

const router = Router();
router.use(requireAuth);

// GET /api/gateway/:workspaceId — 取得當前 config + 狀態
router.get("/:workspaceId", async (req, res, next) => {
  try {
    const ws = await prisma.workspace.findUnique({ where: { id: req.params.workspaceId } });
    if (!ws) throw new AppError(404, "Workspace not found");

    const stored = await prisma.gatewayConfig.findUnique({
      where: { workspaceId: req.params.workspaceId },
    });

    // Health check to gateway
    let gatewayOnline = false;
    try {
      const r = await fetch(`${ws.gatewayUrl}/health`, { signal: AbortSignal.timeout(2000) });
      gatewayOnline = r.ok;
    } catch { /* gateway offline */ }

    res.json({
      gatewayUrl:    ws.gatewayUrl,
      gatewayOnline,
      lastPushedAt:  stored?.lastPushedAt ?? null,
      validationOk:  stored?.validationOk ?? false,
      validationMsg: stored?.validationMsg ?? null,
      rawJson5:      stored?.rawJson5 ?? null,
    });
  } catch (e) { next(e); }
});

// POST /api/gateway/:workspaceId/preview — 預覽 config，不推送
router.post("/:workspaceId/preview", async (req, res, next) => {
  try {
    const config     = await buildGatewayConfig(req.params.workspaceId);
    const validation = validateConfig(config);
    res.json({
      config,
      validation,
      preview: JSON.stringify(config, null, 2),
    });
  } catch (e) { next(e); }
});

// POST /api/gateway/:workspaceId/validate — 驗證 config
router.post("/:workspaceId/validate", async (req, res, next) => {
  try {
    const config     = await buildGatewayConfig(req.params.workspaceId);
    const validation = validateConfig(config);

    const ws = await prisma.workspace.findUnique({ where: { id: req.params.workspaceId } });
    await prisma.gatewayConfig.upsert({
      where:  { workspaceId: req.params.workspaceId },
      update: {
        configJson:   config,
        rawJson5:     JSON.stringify(config, null, 2),
        lastValidAt:  new Date(),
        validationOk: validation.ok,
        validationMsg:validation.message,
      },
      create: {
        workspaceId:  req.params.workspaceId,
        configJson:   config,
        rawJson5:     JSON.stringify(config, null, 2),
        lastValidAt:  new Date(),
        validationOk: validation.ok,
        validationMsg:validation.message,
      },
    });

    res.json({ ...validation, config });
  } catch (e) { next(e); }
});

// POST /api/gateway/:workspaceId/push — 驗證 + 推送至 Gateway
router.post("/:workspaceId/push", async (req, res, next) => {
  try {
    const ws = await prisma.workspace.findUnique({ where: { id: req.params.workspaceId } });
    if (!ws) throw new AppError(404, "Workspace not found");

    const config     = await buildGatewayConfig(req.params.workspaceId);
    const validation = validateConfig(config);

    if (!validation.ok) {
      return res.status(400).json({ ok: false, message: validation.message, config });
    }

    const result = await pushConfigToGateway(req.params.workspaceId, ws.gatewayUrl, config);
    res.json(result);
  } catch (e) { next(e); }
});

// PATCH /api/gateway/:workspaceId/url — 更新 Gateway URL
router.patch("/:workspaceId/url", async (req, res, next) => {
  try {
    const { gatewayUrl } = req.body;
    if (!gatewayUrl) throw new AppError(400, "gatewayUrl required");
    const ws = await prisma.workspace.update({
      where: { id: req.params.workspaceId },
      data:  { gatewayUrl },
    });
    res.json({ gatewayUrl: ws.gatewayUrl });
  } catch (e) { next(e); }
});

export default router;
