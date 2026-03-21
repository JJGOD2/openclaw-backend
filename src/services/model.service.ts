// src/services/model.service.ts
// 多模型管理：catalog、config、切換、cost estimation
import { prisma } from "@/db/client";
import { withCache, CacheKey, TTL } from "@/lib/cache/cache";
import { ModelProvider } from "@prisma/client";

// ── Model Catalog ─────────────────────────────────────────────
export interface ModelInfo {
  id:            string;
  provider:      ModelProvider;
  name:          string;
  contextWindow: number;
  inputCostPer1k:  number;    // USD
  outputCostPer1k: number;    // USD
  speed:         "fast" | "balanced" | "powerful";
  recommended:   boolean;
  description:   string;
}

export const MODEL_CATALOG: ModelInfo[] = [
  {
    id:              "anthropic/claude-3-haiku",
    provider:        "ANTHROPIC",
    name:            "Claude Haiku 4.5",
    contextWindow:   200_000,
    inputCostPer1k:  0.00025,
    outputCostPer1k: 0.00125,
    speed:           "fast",
    recommended:     false,
    description:     "最快、最省成本，適合簡單客服問答與大量請求",
  },
  {
    id:              "anthropic/claude-3-5-sonnet",
    provider:        "ANTHROPIC",
    name:            "Claude Sonnet 4",
    contextWindow:   200_000,
    inputCostPer1k:  0.003,
    outputCostPer1k: 0.015,
    speed:           "balanced",
    recommended:     true,
    description:     "智慧與速度的最佳平衡，推薦用於大多數 Agent 場景",
  },
  {
    id:              "anthropic/claude-3-opus",
    provider:        "ANTHROPIC",
    name:            "Claude Opus 4.6",
    contextWindow:   200_000,
    inputCostPer1k:  0.015,
    outputCostPer1k: 0.075,
    speed:           "powerful",
    recommended:     false,
    description:     "最強推理能力，適合複雜分析、長文摘要、高品質回覆",
  },
];

// ── Cost estimation ───────────────────────────────────────────
export function estimateCostNTD(
  modelId:      string,
  inputTokens:  number,
  outputTokens: number
): number {
  const model  = MODEL_CATALOG.find(m => m.id === modelId);
  if (!model) return 0;
  const usd    = (inputTokens  / 1000) * model.inputCostPer1k +
                 (outputTokens / 1000) * model.outputCostPer1k;
  return Math.round(usd * 32 * 100) / 100;   // ~32 NTD/USD
}

// ── Get effective model config for an agent ───────────────────
export async function getModelConfig(
  workspaceId: string,
  agentId?:    string
): Promise<{ modelId: string; maxTokens: number; temperature: number; topP: number | null }> {
  // Agent-specific config takes priority
  if (agentId) {
    const agentCfg = await withCache(
      CacheKey.modelConfig(workspaceId, agentId),
      () => prisma.modelConfig.findUnique({ where: { agentId } }),
      TTL.MEDIUM
    );
    if (agentCfg) return {
      modelId:     agentCfg.modelId,
      maxTokens:   agentCfg.maxTokens,
      temperature: agentCfg.temperature,
      topP:        agentCfg.topP,
    };
  }

  // Workspace default
  const wsCfg = await prisma.modelConfig.findFirst({
    where: { workspaceId, agentId: null },
  });
  if (wsCfg) return {
    modelId:     wsCfg.modelId,
    maxTokens:   wsCfg.maxTokens,
    temperature: wsCfg.temperature,
    topP:        wsCfg.topP,
  };

  // Platform default
  return { modelId: process.env.OPENROUTER_MODEL ?? "anthropic/claude-3-5-sonnet", maxTokens: 1024, temperature: 0.7, topP: null };
}

// ── Upsert model config ───────────────────────────────────────
export async function saveModelConfig(params: {
  workspaceId:  string;
  agentId?:     string;
  modelId:      string;
  maxTokens?:   number;
  temperature?: number;
  topP?:        number | null;
}): Promise<void> {
  const data = {
    workspaceId:  params.workspaceId,
    agentId:      params.agentId ?? null,
    modelId:      params.modelId,
    maxTokens:    params.maxTokens   ?? 1024,
    temperature:  params.temperature ?? 0.7,
    topP:         params.topP        ?? null,
  };

  if (params.agentId) {
    await prisma.modelConfig.upsert({
      where:  { agentId: params.agentId },
      update: data,
      create: data,
    });
  } else {
    const existing = await prisma.modelConfig.findFirst({
      where: { workspaceId: params.workspaceId, agentId: null },
    });
    if (existing) {
      await prisma.modelConfig.update({ where: { id: existing.id }, data });
    } else {
      await prisma.modelConfig.create({ data });
    }
  }
}
