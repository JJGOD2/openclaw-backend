// src/middleware/rateLimit.ts
// 輕量 Rate Limiter（Token Bucket，不需 Redis）
// 生產環境如需跨 process 限速請換 rate-limiter-flexible + Redis
import { Request, Response, NextFunction } from "express";

interface BucketEntry {
  tokens:     number;
  lastRefill: number;
}

// Global in-memory store
const buckets = new Map<string, BucketEntry>();

// Cleanup old entries every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - 5 * 60_000;
  for (const [k, v] of buckets.entries()) {
    if (v.lastRefill < cutoff) buckets.delete(k);
  }
}, 5 * 60_000);

export interface RateLimitOptions {
  windowMs:   number;    // refill interval in ms
  max:        number;    // max requests per window
  keyFn?:     (req: Request) => string;
  message?:   string;
  skipPaths?: RegExp;
}

export function rateLimit(opts: RateLimitOptions) {
  const {
    windowMs,
    max,
    message   = "Too many requests, please try again later.",
    keyFn     = (req) => req.ip ?? "unknown",
    skipPaths,
  } = opts;

  return (req: Request, res: Response, next: NextFunction) => {
    if (skipPaths?.test(req.path)) return next();

    const key  = keyFn(req);
    const now  = Date.now();
    const entry = buckets.get(key);

    if (!entry || now - entry.lastRefill >= windowMs) {
      // New window → full bucket
      buckets.set(key, { tokens: max - 1, lastRefill: now });
      setRateLimitHeaders(res, max - 1, max);
      return next();
    }

    if (entry.tokens <= 0) {
      const retryAfter = Math.ceil((entry.lastRefill + windowMs - now) / 1000);
      res.setHeader("Retry-After",           String(retryAfter));
      res.setHeader("X-RateLimit-Limit",     String(max));
      res.setHeader("X-RateLimit-Remaining", "0");
      res.setHeader("X-RateLimit-Reset",     String(Math.ceil((entry.lastRefill + windowMs) / 1000)));
      return res.status(429).json({ error: message, retryAfterSeconds: retryAfter });
    }

    entry.tokens--;
    setRateLimitHeaders(res, entry.tokens, max);
    next();
  };
}

function setRateLimitHeaders(res: Response, remaining: number, limit: number) {
  res.setHeader("X-RateLimit-Limit",     String(limit));
  res.setHeader("X-RateLimit-Remaining", String(Math.max(0, remaining)));
}

// ── Preset limiters ───────────────────────────────────────────

/** 每 IP 每分鐘 60 次 API 呼叫 */
export const apiLimiter = rateLimit({
  windowMs: 60_000,
  max:      60,
  message:  "API 呼叫頻率過高，請稍後再試",
  skipPaths:/^\/health/,
});

/** 登入頁面：每 IP 每 15 分鐘 10 次 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max:      10,
  message:  "登入嘗試次數過多，請 15 分鐘後再試",
});

/** Webhook 端點：每 IP 每分鐘 120 次 */
export const webhookLimiter = rateLimit({
  windowMs: 60_000,
  max:      120,
  message:  "Webhook 請求頻率過高",
});

/** Public API：每 API Key 每分鐘 30 次 */
export const publicApiLimiter = rateLimit({
  windowMs: 60_000,
  max:      30,
  keyFn:    (req) => (req.headers["x-api-key"] as string) ?? req.ip ?? "unknown",
  message:  "API Key 呼叫頻率超限",
});
