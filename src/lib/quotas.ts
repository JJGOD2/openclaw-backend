// src/lib/quotas.ts
// Plan 配額定義 + 執行中間件
import { PlanType } from "@prisma/client";
import { prisma } from "@/db/client";
import { Request, Response, NextFunction } from "express";
import { AuthRequest } from "@/middleware/auth";

// ── Plan 配額上限 ─────────────────────────────────────────────
export const PLAN_QUOTAS: Record<PlanType, {
  maxWorkspaces:  number;
  maxAgents:      number;     // per workspace
  maxChannels:    number;     // per workspace
  maxMessages:    number;     // per month (0 = unlimited)
  maxTokens:      number;     // per month (0 = unlimited)
  allowedFeatures:string[];
}> = {
  STARTER: {
    maxWorkspaces:  1,
    maxAgents:      3,
    maxChannels:    2,
    maxMessages:    3_000,
    maxTokens:      500_000,
    allowedFeatures:["logs","usage","security","templates"],
  },
  PRO: {
    maxWorkspaces:  10,
    maxAgents:      0,        // unlimited
    maxChannels:    0,
    maxMessages:    50_000,
    maxTokens:      5_000_000,
    allowedFeatures:["logs","usage","security","templates","review","gateway",
                     "alerts","sessions","integrations","analytics"],
  },
  BUSINESS: {
    maxWorkspaces:  0,
    maxAgents:      0,
    maxChannels:    0,
    maxMessages:    0,
    maxTokens:      0,
    allowedFeatures:["*"],    // all features
  },
};

export type QuotaType = "workspaces" | "agents" | "channels" | "messages" | "tokens";

// ── Check quota ───────────────────────────────────────────────
export async function checkQuota(
  workspaceId: string,
  type:        QuotaType,
  increment =  1
): Promise<{ allowed: boolean; current: number; limit: number; plan: PlanType }> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) return { allowed: false, current: 0, limit: 0, plan: "STARTER" };

  const plan   = workspace.plan;
  const quotas = PLAN_QUOTAS[plan];

  let current = 0;
  let limit   = 0;

  switch (type) {
    case "agents": {
      current = await prisma.agent.count({ where: { workspaceId } });
      limit   = quotas.maxAgents;
      break;
    }
    case "channels": {
      current = await prisma.channelBinding.count({ where: { workspaceId } });
      limit   = quotas.maxChannels;
      break;
    }
    case "workspaces": {
      // Count workspaces for the same billing customer
      current = await prisma.workspace.count();
      limit   = quotas.maxWorkspaces;
      break;
    }
    case "messages": {
      const startOfMonth = new Date();
      startOfMonth.setDate(1); startOfMonth.setHours(0, 0, 0, 0);
      const usage = await prisma.usageRecord.aggregate({
        where:  { workspaceId, date: { gte: startOfMonth } },
        _sum:   { messages: true },
      });
      current = usage._sum.messages ?? 0;
      limit   = quotas.maxMessages;
      break;
    }
    case "tokens": {
      const startOfMonth = new Date();
      startOfMonth.setDate(1); startOfMonth.setHours(0, 0, 0, 0);
      const usage = await prisma.usageRecord.aggregate({
        where:  { workspaceId, date: { gte: startOfMonth } },
        _sum:   { inputTokens: true, outputTokens: true },
      });
      current = (usage._sum.inputTokens ?? 0) + (usage._sum.outputTokens ?? 0);
      limit   = quotas.maxTokens;
      break;
    }
  }

  // limit = 0 means unlimited
  const allowed = limit === 0 || (current + increment) <= limit;
  return { allowed, current, limit, plan };
}

// ── Feature gate ──────────────────────────────────────────────
export async function hasFeature(workspaceId: string, feature: string): Promise<boolean> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) return false;
  const features = PLAN_QUOTAS[workspace.plan].allowedFeatures;
  return features.includes("*") || features.includes(feature);
}

// ── Express middleware: enforce quota ─────────────────────────
export function enforceQuota(type: QuotaType) {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    const workspaceId = req.body?.workspaceId ?? (req.query?.workspaceId as string);
    if (!workspaceId) return next();

    const result = await checkQuota(workspaceId, type);
    if (!result.allowed) {
      return res.status(429).json({
        error:   `已達 ${type} 配額上限`,
        current: result.current,
        limit:   result.limit,
        plan:    result.plan,
        upgrade: "請升級方案以取得更多配額",
      });
    }
    next();
  };
}

// ── GET /api/quotas/:workspaceId ──────────────────────────────
import { Router } from "express";
import { requireAuth } from "@/middleware/auth";

export const quotaRouter = Router();
quotaRouter.use(requireAuth);

quotaRouter.get("/:workspaceId", async (req, res, next) => {
  try {
    const { workspaceId } = req.params;
    const [agents, channels, messages, tokens] = await Promise.all([
      checkQuota(workspaceId, "agents",   0),
      checkQuota(workspaceId, "channels", 0),
      checkQuota(workspaceId, "messages", 0),
      checkQuota(workspaceId, "tokens",   0),
    ]);

    res.json({
      plan:   agents.plan,
      quotas: {
        agents:   { current: agents.current,   limit: agents.limit,   pct: agents.limit   ? Math.round(agents.current   / agents.limit   * 100) : 0 },
        channels: { current: channels.current, limit: channels.limit, pct: channels.limit ? Math.round(channels.current / channels.limit * 100) : 0 },
        messages: { current: messages.current, limit: messages.limit, pct: messages.limit ? Math.round(messages.current / messages.limit * 100) : 0 },
        tokens:   { current: tokens.current,   limit: tokens.limit,   pct: tokens.limit   ? Math.round(tokens.current   / tokens.limit   * 100) : 0 },
      },
    });
  } catch (e) { next(e); }
});
