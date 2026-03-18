// src/lib/circuit-breaker.ts
// 熔斷器：保護系統不被上游 API 故障拖垮
// 狀態機：CLOSED → OPEN → HALF_OPEN → CLOSED
import { prisma } from "@/db/client";

type CBState = "CLOSED" | "OPEN" | "HALF_OPEN";

interface CBOptions {
  name:               string;   // circuit name (e.g. "claude-api", "line-api")
  failureThreshold:   number;   // failures before opening (default 5)
  successThreshold:   number;   // successes in HALF_OPEN to close (default 2)
  timeoutMs:          number;   // how long to stay OPEN before trying (default 30s)
  requestTimeoutMs?:  number;   // individual request timeout
}

interface CBStats {
  state:        CBState;
  failures:     number;
  successes:    number;
  lastFailure?: Date;
  lastSuccess?: Date;
  nextAttempt?: Date;
}

// In-memory state (consider Redis for multi-instance)
const circuits = new Map<string, CBStats & { opts: CBOptions }>();

function getOrCreate(opts: CBOptions): CBStats & { opts: CBOptions } {
  if (!circuits.has(opts.name)) {
    circuits.set(opts.name, {
      state:    "CLOSED",
      failures: 0,
      successes:0,
      opts,
    });
  }
  return circuits.get(opts.name)!;
}

// ── Execute with circuit breaker protection ───────────────────
export async function withCircuitBreaker<T>(
  opts:    CBOptions,
  fn:      () => Promise<T>,
  fallback?: () => T | Promise<T>
): Promise<T> {
  const cb = getOrCreate(opts);
  const now = new Date();

  // OPEN: check if timeout has passed
  if (cb.state === "OPEN") {
    if (cb.nextAttempt && now >= cb.nextAttempt) {
      cb.state    = "HALF_OPEN";
      cb.successes = 0;
      console.log(`[CB] ${opts.name}: OPEN → HALF_OPEN (試探性請求)`);
    } else {
      // Still OPEN — reject fast
      const waitMs = cb.nextAttempt ? cb.nextAttempt.getTime() - now.getTime() : 0;
      if (fallback) return fallback();
      throw new CircuitOpenError(opts.name, Math.ceil(waitMs / 1000));
    }
  }

  // Execute the function
  const timeoutMs = opts.requestTimeoutMs ?? 10_000;
  try {
    const result = await Promise.race([
      fn(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs)
      ),
    ]);

    // Success
    cb.lastSuccess = now;
    if (cb.state === "HALF_OPEN") {
      cb.successes++;
      if (cb.successes >= opts.successThreshold) {
        cb.state    = "CLOSED";
        cb.failures = 0;
        console.log(`[CB] ${opts.name}: HALF_OPEN → CLOSED ✓`);
        await logCBEvent(opts.name, "CLOSED", "熔斷器恢復正常");
      }
    } else {
      cb.failures = Math.max(0, cb.failures - 1);   // gradual recovery
    }
    return result;

  } catch (err) {
    cb.failures++;
    cb.lastFailure = now;
    const errMsg = (err as Error).message;

    if (cb.state === "HALF_OPEN") {
      // HALF_OPEN failure → back to OPEN
      cb.state      = "OPEN";
      cb.successes  = 0;
      cb.nextAttempt= new Date(now.getTime() + opts.timeoutMs);
      console.warn(`[CB] ${opts.name}: HALF_OPEN → OPEN (試探失敗)`);
    } else if (cb.failures >= opts.failureThreshold) {
      // Too many failures → OPEN
      cb.state       = "OPEN";
      cb.nextAttempt = new Date(now.getTime() + opts.timeoutMs);
      console.error(`[CB] ${opts.name}: CLOSED → OPEN (${cb.failures} 次失敗)`);
      await logCBEvent(opts.name, "OPEN", `連續失敗 ${cb.failures} 次，熔斷器開啟`);
    }

    if (fallback) return fallback();
    throw err;
  }
}

// ── Get all circuit states (for monitoring) ───────────────────
export function getCircuitStates(): Record<string, { state:CBState; failures:number; nextAttempt?:Date }> {
  const result: Record<string, { state:CBState; failures:number; nextAttempt?:Date }> = {};
  for (const [name, cb] of circuits) {
    result[name] = { state: cb.state, failures: cb.failures, nextAttempt: cb.nextAttempt };
  }
  return result;
}

// ── Force reset a circuit ─────────────────────────────────────
export function resetCircuit(name: string): boolean {
  const cb = circuits.get(name);
  if (!cb) return false;
  cb.state    = "CLOSED";
  cb.failures = 0;
  cb.successes= 0;
  delete cb.nextAttempt;
  return true;
}

// ── Pre-configured circuits for known services ────────────────
export const CIRCUITS = {
  CLAUDE_API: {
    name:             "claude-api",
    failureThreshold: 5,
    successThreshold: 2,
    timeoutMs:        30_000,
    requestTimeoutMs: 30_000,
  },
  LINE_API: {
    name:             "line-api",
    failureThreshold: 10,
    successThreshold: 3,
    timeoutMs:        60_000,
    requestTimeoutMs: 8_000,
  },
  TELEGRAM_API: {
    name:             "telegram-api",
    failureThreshold: 10,
    successThreshold: 3,
    timeoutMs:        60_000,
    requestTimeoutMs: 8_000,
  },
  GATEWAY: {
    name:             "gateway",
    failureThreshold: 3,
    successThreshold: 1,
    timeoutMs:        120_000,
    requestTimeoutMs: 5_000,
  },
  VOYAGE_API: {
    name:             "voyage-api",
    failureThreshold: 5,
    successThreshold: 2,
    timeoutMs:        60_000,
    requestTimeoutMs: 15_000,
  },
} as const;

async function logCBEvent(circuit: string, state: string, reason: string) {
  try {
    await prisma.logEntry.create({
      data: {
        workspaceId: "system",
        type:        state === "OPEN" ? "WARN" : "SYSTEM",
        message:     `[Circuit Breaker] ${circuit}: ${reason}`,
        metadata:    { circuit, state, timestamp: new Date().toISOString() },
      },
    }).catch(() => {});   // don't throw if DB also broken
  } catch { /* ignore */ }
}

export class CircuitOpenError extends Error {
  constructor(public circuit: string, public retryAfterSeconds: number) {
    super(`Circuit ${circuit} is OPEN. Retry after ${retryAfterSeconds}s.`);
    this.name = "CircuitOpenError";
  }
}
