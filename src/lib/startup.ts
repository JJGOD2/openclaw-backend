// src/lib/startup.ts
// 啟動時驗證所有必要環境變數，缺少就直接 exit(1)
// 比跑了一半才發現缺 key 好得多

interface EnvSpec {
  key:      string;
  desc:     string;
  required: boolean;
  validate?: (v: string) => string | null;   // return error string or null
}

const ENV_SPECS: EnvSpec[] = [
  // ── Critical (hard fail) ────────────────────────────────
  {
    key:      "DATABASE_URL",
    desc:     "PostgreSQL 連線字串",
    required: true,
    validate: v => v.startsWith("postgresql://") ? null : "必須以 postgresql:// 開頭",
  },
  {
    key:      "JWT_SECRET",
    desc:     "JWT 簽名金鑰",
    required: true,
    validate: v => v.length >= 32 ? null : `太短（${v.length} 字元），至少需要 32 字元`,
  },
  {
    key:      "ENCRYPTION_KEY",
    desc:     "Secret 加密金鑰",
    required: true,
    validate: v => v.length === 64 && /^[0-9a-f]+$/i.test(v)
      ? null
      : "必須是 64 位元 hex 字串（openssl rand -hex 32）",
  },
  // ── Warning only (soft warn) ────────────────────────────
  {
    key:      "OPENROUTER_API_KEY",
    desc:     "OpenRouter API Key",
    required: false,
    validate: v => v.startsWith("sk-or-") ? null : "格式可能不符（應以 sk-or- 開頭）",
  },
  {
    key:      "FRONTEND_URL",
    desc:     "前端 URL（OAuth callback 用）",
    required: false,
    validate: v => v.startsWith("http") ? null : "應以 http:// 或 https:// 開頭",
  },
  {
    key:      "BACKEND_URL",
    desc:     "後端 URL（OAuth callback 用）",
    required: false,
    validate: v => v.startsWith("http") ? null : "應以 http:// 或 https:// 開頭",
  },
];

// Dev-mode special: warn if using known-insecure defaults
const INSECURE_DEFAULTS: Record<string, string> = {
  JWT_SECRET:      "dev-secret",
  ENCRYPTION_KEY:  "0".repeat(64),
};

export function validateEnv(): void {
  const errors:   string[] = [];
  const warnings: string[] = [];
  const isProd    = process.env.NODE_ENV === "production";

  for (const spec of ENV_SPECS) {
    const val = process.env[spec.key];

    if (!val || val.trim() === "" || val === "PLACEHOLDER") {
      if (spec.required) {
        errors.push(`  ✗ ${spec.key}  — ${spec.desc} (必填)`);
      } else {
        warnings.push(`  △ ${spec.key}  — ${spec.desc} (未設定，相關功能停用)`);
      }
      continue;
    }

    if (spec.validate) {
      const err = spec.validate(val);
      if (err) {
        if (spec.required) {
          errors.push(`  ✗ ${spec.key}  — ${err}`);
        } else {
          warnings.push(`  △ ${spec.key}  — ${err}`);
        }
      }
    }

    // Check insecure defaults in production
    if (isProd && INSECURE_DEFAULTS[spec.key] === val) {
      errors.push(`  ✗ ${spec.key}  — 使用了不安全的預設值，生產環境必須更換！`);
    }
  }

  // Report
  const border = "─".repeat(52);
  if (warnings.length > 0) {
    console.warn(`\n┌${border}┐`);
    console.warn(`│  ⚠ 環境設定警告（功能可能受限）`);
    console.warn(`├${border}┤`);
    warnings.forEach(w => console.warn(`│${w}`));
    console.warn(`└${border}┘\n`);
  }

  if (errors.length > 0) {
    console.error(`\n╔${"═".repeat(52)}╗`);
    console.error(`║  ✗ 啟動失敗：環境設定錯誤`);
    console.error(`╠${"═".repeat(52)}╣`);
    errors.forEach(e => console.error(`║${e}`));
    console.error(`╠${"═".repeat(52)}╣`);
    console.error(`║  請修正以上設定後重新啟動`);
    console.error(`╚${"═".repeat(52)}╝\n`);
    process.exit(1);
  }

  console.log("✓ 環境設定驗證通過");
}

// ── Graceful shutdown ─────────────────────────────────────────
export function setupGracefulShutdown(
  server:  import("http").Server,
  onClose: () => Promise<void>
): void {
  let isShuttingDown = false;

  async function shutdown(signal: string) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n[Shutdown] ${signal} 收到，開始優雅關閉...`);

    // Stop accepting new connections
    server.close(async () => {
      console.log("[Shutdown] HTTP server 已關閉");
      try {
        await onClose();
        console.log("[Shutdown] 資料庫連線已關閉");
      } catch (err) {
        console.error("[Shutdown] 關閉時出錯：", err);
      }
      console.log("[Shutdown] 完成，再見！");
      process.exit(0);
    });

    // Force kill after 10 seconds
    setTimeout(() => {
      console.error("[Shutdown] 超時，強制關閉");
      process.exit(1);
    }, 10_000);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT",  () => shutdown("SIGINT"));
  process.on("uncaughtException", (err) => {
    console.error("[Fatal] 未捕獲的例外：", err);
    shutdown("uncaughtException").then(() => process.exit(1));
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[Fatal] 未處理的 Promise rejection：", reason);
  });
}
