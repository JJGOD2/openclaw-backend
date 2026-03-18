// src/lib/cache/cache.ts
// 型別化的快取包裝層
import { cacheGet, cacheSet, cacheDel, cacheDelPattern } from "./redis";

// TTL 預設
export const TTL = {
  SHORT:   60,          // 1 分鐘  — 頻繁變動的資料 (usage, sessions)
  MEDIUM:  300,         // 5 分鐘  — 中頻率 (agents, tools)
  LONG:    1800,        // 30 分鐘 — 低頻率 (workspace config, templates)
  DAY:     86_400,      // 1 天    — 幾乎靜態 (plan quotas, model catalog)
} as const;

// ── JSON helper ───────────────────────────────────────────────
export async function cacheGetJSON<T>(key: string): Promise<T | null> {
  const raw = await cacheGet(key);
  if (raw === null) return null;
  try { return JSON.parse(raw) as T; }
  catch { return null; }
}

export async function cacheSetJSON<T>(
  key:       string,
  value:     T,
  ttlSeconds = TTL.MEDIUM
): Promise<void> {
  await cacheSet(key, JSON.stringify(value), ttlSeconds);
}

// ── Cache-aside pattern ───────────────────────────────────────
export async function withCache<T>(
  key:       string,
  fetcher:   () => Promise<T>,
  ttlSeconds = TTL.MEDIUM
): Promise<T> {
  const cached = await cacheGetJSON<T>(key);
  if (cached !== null) return cached;

  const value = await fetcher();
  await cacheSetJSON(key, value, ttlSeconds);
  return value;
}

// ── Key builders (namespaced to avoid collisions) ─────────────
export const CacheKey = {
  workspace:      (id: string)              => `ws:${id}`,
  agents:         (wsId: string)            => `ws:${wsId}:agents`,
  agent:          (id: string)              => `agent:${id}`,
  modelConfig:    (wsId: string, agId?: string) => agId ? `mc:${wsId}:${agId}` : `mc:${wsId}`,
  quotas:         (wsId: string)            => `quota:${wsId}`,
  planQuotas:     (plan: string)            => `plan:${plan}:quotas`,
  tools:          (wsId: string)            => `ws:${wsId}:tools`,
  templates:      (wsId: string)            => `ws:${wsId}:templates`,
  kbChunks:       (kbId: string)            => `kb:${kbId}:chunks`,
  circuitState:   (name: string)            => `cb:${name}`,
  featureFlag:    (flag: string, wsId?: string) => wsId ? `ff:${flag}:${wsId}` : `ff:${flag}`,
  analyticsDay:   (wsId: string, date: string)  => `analytics:${wsId}:${date}`,
};

// ── Invalidation helpers ──────────────────────────────────────
export async function invalidateWorkspace(wsId: string): Promise<void> {
  await Promise.all([
    cacheDel(CacheKey.workspace(wsId)),
    cacheDel(CacheKey.agents(wsId)),
    cacheDel(CacheKey.tools(wsId)),
    cacheDel(CacheKey.quotas(wsId)),
    cacheDel(CacheKey.templates(wsId)),
    cacheDelPattern(`ws:${wsId}:*`),
  ]);
}

export async function invalidateAgent(agentId: string, wsId: string): Promise<void> {
  await Promise.all([
    cacheDel(CacheKey.agent(agentId)),
    cacheDel(CacheKey.agents(wsId)),
    cacheDel(CacheKey.modelConfig(wsId, agentId)),
  ]);
}

export { cacheDel, cacheDelPattern };
