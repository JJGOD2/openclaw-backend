// src/routes/models.ts
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "@/middleware/auth";
import { AppError } from "@/middleware/errorHandler";
import { MODEL_CATALOG, getModelConfig, saveModelConfig, estimateCostNTD } from "@/services/model.service";

const router = Router();
router.use(requireAuth);

// GET /api/models/catalog
router.get("/catalog", (_req, res) => res.json(MODEL_CATALOG));

// GET /api/models/config?workspaceId=&agentId=
router.get("/config", async (req, res, next) => {
  try {
    const { workspaceId, agentId } = z.object({
      workspaceId: z.string().cuid(),
      agentId:     z.string().cuid().optional(),
    }).parse(req.query);

    const config = await getModelConfig(workspaceId, agentId);
    const model  = MODEL_CATALOG.find(m => m.id === config.modelId);
    res.json({ ...config, modelInfo: model ?? null });
  } catch (e) { next(e); }
});

// POST /api/models/config
router.post("/config", async (req, res, next) => {
  try {
    const body = z.object({
      workspaceId: z.string().cuid(),
      agentId:     z.string().cuid().optional(),
      modelId:     z.string().min(1),
      maxTokens:   z.number().min(1).max(8096).optional(),
      temperature: z.number().min(0).max(1).optional(),
      topP:        z.number().min(0).max(1).nullable().optional(),
    }).parse(req.body);

    const valid = MODEL_CATALOG.find(m => m.id === body.modelId);
    if (!valid) throw new AppError(400, `Unknown model: ${body.modelId}`);

    await saveModelConfig(body);
    res.json({ ok: true, modelId: body.modelId });
  } catch (e) { next(e); }
});

// POST /api/models/cost-estimate
router.post("/cost-estimate", (req, res, next) => {
  try {
    const { modelId, inputTokens, outputTokens } = z.object({
      modelId:      z.string(),
      inputTokens:  z.number().min(0),
      outputTokens: z.number().min(0),
    }).parse(req.body);

    const costNTD = estimateCostNTD(modelId, inputTokens, outputTokens);
    const model   = MODEL_CATALOG.find(m => m.id === modelId);
    res.json({ costNTD, model: model?.name ?? modelId });
  } catch (e) { next(e); }
});

export default router;
