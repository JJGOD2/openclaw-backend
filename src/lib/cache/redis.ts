// src/lib/cache/redis.ts
// Redis 客戶端：有 Redis 就用，沒有就 in-memory fallback
// 不需要 redis npm 套件，使用 ioredis（可選），降級到 Map
import { createClient } from "redis";

type RedisClient = ReturnType<typeof createClient>;

let client: RedisClient | null = null;
let useMemory = false;

// In-memory fallback store
const memStore = new Map<string, { value: string; expiresAt?: number }>();

// ── Initialise ────────────────────────────────────────────────
export async function initRedis(): Promise<void> {
  const url = process.env.REDIS_URL ?? "";
  if (!url) {
    console.warn("[Redis] REDIS_URL not set, using in-memory fallback");
    useMemory = true;
    return;
  }

  try {
    client = createClient({ url, socket: { connectTimeout: 5000 } });
    client.on("error", (err) => {
      console.warn("[Redis] Connection error, falling back to memory:", err.message);
      useMemory = true;
      client   = null;
    });
    await client.connect();
    useMemory = false;
    console.log("[Redis] Connected ✓");
  } catch (err) {
    console.warn("[Redis] Failed to connect, using in-memory fallback:", (err as Error).message);
    useMemory = true;
    client    = null;
  }
}

// ── Core operations ───────────────────────────────────────────
export async function cacheGet(key: string): Promise<string | null> {
  if (!useMemory && client) {
    return client.get(key);
  }
  // Memory fallback
  const entry = memStore.get(key);
  if (!entry) return null;
  if (entry.expiresAt && entry.expiresAt < Date.now()) {
    memStore.delete(key);
    return null;
  }
  return entry.value;
}

export async function cacheSet(
  key:   string,
  value: string,
  ttlSeconds?: number
): Promise<void> {
  if (!useMemory && client) {
    if (ttlSeconds) {
      await client.setEx(key, ttlSeconds, value);
    } else {
      await client.set(key, value);
    }
    return;
  }
  memStore.set(key, {
    value,
    expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined,
  });
}

export async function cacheDel(key: string): Promise<void> {
  if (!useMemory && client) {
    await client.del(key);
    return;
  }
  memStore.delete(key);
}

export async function cacheDelPattern(pattern: string): Promise<void> {
  if (!useMemory && client) {
    // Use SCAN for safety (KEYS is dangerous on large datasets)
    let cursor = 0;
    do {
      const result = await client.scan(cursor, { MATCH: pattern, COUNT: 100 });
      cursor = result.cursor;
      if (result.keys.length > 0) await client.del(result.keys);
    } while (cursor !== 0);
    return;
  }
  const regex = new RegExp("^" + pattern.replace("*", ".*") + "$");
  for (const k of memStore.keys()) {
    if (regex.test(k)) memStore.delete(k);
  }
}

export function getCacheStats(): { backend: string; memKeys: number } {
  return {
    backend: useMemory ? "memory" : "redis",
    memKeys: memStore.size,
  };
}
