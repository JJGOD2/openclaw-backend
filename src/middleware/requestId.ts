// src/middleware/requestId.ts
// 每個請求注入唯一 ID，方便跨服務追蹤
import { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      startTime: number;
    }
  }
}

export function requestId() {
  return (req: Request, res: Response, next: NextFunction) => {
    const id = (req.headers["x-request-id"] as string) ?? `req_${randomUUID().slice(0,8)}`;
    req.requestId = id;
    req.startTime = Date.now();

    // Forward the ID in the response for client-side correlation
    res.setHeader("X-Request-Id", id);

    // Log after response finishes
    res.on("finish", () => {
      const ms       = Date.now() - req.startTime;
      const status   = res.statusCode;
      const method   = req.method;
      const path     = req.path;
      const color    = status >= 500 ? "\x1b[31m"  // red
                     : status >= 400 ? "\x1b[33m"  // yellow
                     : status >= 200 ? "\x1b[32m"  // green
                     : "\x1b[0m";
      const reset    = "\x1b[0m";

      if (process.env.NODE_ENV !== "test") {
        console.log(
          `${color}${status}${reset} ${method} ${path} ${ms}ms [${id}]`
        );
      }
    });

    next();
  };
}

// ── Structured logger using request context ───────────────────
export function createLogger(req: Request) {
  const base = { requestId: req.requestId, path: req.path };
  return {
    info:  (msg: string, extra?: object) => console.log(JSON.stringify({ level:"info",  msg, ...base, ...extra })),
    warn:  (msg: string, extra?: object) => console.warn(JSON.stringify({ level:"warn",  msg, ...base, ...extra })),
    error: (msg: string, extra?: object) => console.error(JSON.stringify({ level:"error", msg, ...base, ...extra })),
  };
}
