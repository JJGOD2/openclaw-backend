// src/lib/flags/feature-flags.ts
// 功能旗標系統 — 可以針對 workspace、plan、或全域開關功能
// 支援漸進式推出（percentage rollout）
import { prisma } from "@/db/client";
import { withCache, cacheSet, cacheDel, CacheKey, TTL } from "@/lib/cache/cache";

// ── Flag definitions ──────────────────────────────────────────
export interface FlagDef {
  key:         string;
  description: string;
  defaultOn:   boolean;
  plans?:      string[];     // only enabled for these plans (null = all)
  rolloutPct?: number;       // 0-100, deterministic per workspaceId
}

// Master flag registry
export const FLAGS: Record<string, FlagDef> = {
  "rag.enabled": {
    key:         "rag.enabled",
    description: "知識庫 RAG 功能",
    defaultOn:   true,
    plans:       ["PRO","BUSINESS"],
  },
  "ab-testing.enabled": {
    key:         "ab-testing.enabled",
    description: "A/B 測試功能",
    defaultOn:   true,
    plans:       ["PRO","BUSINESS"],
  },
  "chains.enabled": {
    key:         "chains.enabled",
    description: "Agent Chain 鏈式呼叫",
    defaultOn:   true,
    plans:       ["BUSINESS"],
  },
  "broadcast.enabled": {
    key:         "broadcast.enabled",
    description: "廣播推播",
    defaultOn:   true,
    plans:       ["PRO","BUSINESS"],
  },
  "voice.enabled": {
    key:         "voice.enabled",
    description: "語音 (Twilio) 整合",
    defaultOn:   false,    // manual opt-in
    plans:       ["BUSINESS"],
  },
  "prompt-guard.enabled": {
    key:         "prompt-guard.enabled",
    description: "Prompt 注入防護",
    defaultOn:   true,     // on for everyone
  },
  "auto-translate.enabled": {
    key:         "auto-translate.enabled",
    description: "自動翻譯（多語言輸入）",
    defaultOn:   false,
    plans:       ["PRO","BUSINESS"],
  },
  "sla-monitoring.enabled": {
    key:         "sla-monitoring.enabled",
    description: "SLA 監控（健康檢查）",
    defaultOn:   true,
    plans:       ["PRO","BUSINESS"],
  },
  "new-dashboard.enabled": {
    key:         "new-dashboard.enabled",
    description: "新版 Dashboard（Beta）",
    defaultOn:   false,
    rolloutPct:  20,       // 20% of workspaces get the new UI
  },
};

// ── Evaluate a flag for a specific workspace ──────────────────
export async function isEnabled(
  flagKey:     string,
  workspaceId: string
): Promise<boolean> {
  return withCache(
    CacheKey.featureFlag(flagKey, workspaceId),
    () => evaluateFlag(flagKey, workspaceId),
    TTL.MEDIUM
  );
}

async function evaluateFlag(flagKey: string, workspaceId: string): Promise<boolean> {
  const def = FLAGS[flagKey];
  if (!def) return false;    // unknown flag = off

  // Check workspace-specific override (DB takes precedence)
  const override = await prisma.$queryRaw<{ enabled: boolean }[]>`
    SELECT enabled FROM feature_flag_overrides
    WHERE flag_key = ${flagKey} AND workspace_id = ${workspaceId}
    LIMIT 1
  `.catch(() => []);    // table may not exist yet — fail open

  if (override.length > 0) return override[0].enabled;

  // Plan check
  const workspace = await prisma.workspace.findUnique({
    where:  { id: workspaceId },
    select: { plan: true },
  });
  if (!workspace) return false;

  if (def.plans && !def.plans.includes(workspace.plan)) return false;

  // Percentage rollout (deterministic hash of workspaceId)
  if (def.rolloutPct !== undefined && def.rolloutPct < 100) {
    const hash = workspaceId.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0);
    if ((hash % 100) >= def.rolloutPct) return false;
  }

  return def.defaultOn;
}

// ── API: list all flags with current state for a workspace ─────
export async function listFlags(workspaceId: string): Promise<{
  key:         string;
  description: string;
  enabled:     boolean;
  source:      "override" | "plan" | "default" | "rollout";
}[]> {
  const results = await Promise.all(
    Object.values(FLAGS).map(async (def) => {
      const enabled = await isEnabled(def.key, workspaceId);
      return {
        key:         def.key,
        description: def.description,
        enabled,
        source:      "default" as const,
      };
    })
  );
  return results;
}

// ── Admin: set override ───────────────────────────────────────
export async function setFlagOverride(
  flagKey:     string,
  workspaceId: string,
  enabled:     boolean
): Promise<void> {
  // Upsert into feature_flag_overrides (create table if needed)
  await prisma.$executeRaw`
    INSERT INTO feature_flag_overrides (flag_key, workspace_id, enabled, updated_at)
    VALUES (${flagKey}, ${workspaceId}, ${enabled}, NOW())
    ON CONFLICT (flag_key, workspace_id)
    DO UPDATE SET enabled = ${enabled}, updated_at = NOW()
  `.catch(() => {});
  // Invalidate cache
  await cacheDel(CacheKey.featureFlag(flagKey, workspaceId));
}

// Express middleware: inject flags into req
import { Request, Response, NextFunction } from "express";

declare global {
  namespace Express {
    interface Request { flags?: typeof isEnabled }
  }
}

export function featureFlagMiddleware() {
  return (req: Request, _res: Response, next: NextFunction) => {
    req.flags = isEnabled;
    next();
  };
}
