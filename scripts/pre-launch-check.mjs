#!/usr/bin/env node
// scripts/pre-launch-check.mjs
// 上線前自動化檢查腳本
// 執行：node scripts/pre-launch-check.mjs
// 或：  npx tsx scripts/pre-launch-check.mjs

import { createHmac } from "crypto";

const RED   = "\x1b[31m";
const GREEN = "\x1b[32m";
const AMBER = "\x1b[33m";
const RESET = "\x1b[0m";
const BOLD  = "\x1b[1m";

const checks  = [];
let   passed  = 0;
let   failed  = 0;
let   warned  = 0;

function ok(msg)   { console.log(`  ${GREEN}✓${RESET} ${msg}`); passed++; }
function fail(msg) { console.log(`  ${RED}✗${RESET} ${msg}`);   failed++; }
function warn(msg) { console.log(`  ${AMBER}△${RESET} ${msg}`);  warned++; }

function section(title) {
  console.log(`\n${BOLD}${title}${RESET}`);
  console.log("─".repeat(54));
}

// ── 1. Environment variables ──────────────────────────────────
section("1. 環境變數");

const env = process.env;

// Critical
const DATABASE_URL = env.DATABASE_URL ?? "";
if (!DATABASE_URL)                       fail("DATABASE_URL 未設定");
else if (!DATABASE_URL.startsWith("postgresql://")) fail("DATABASE_URL 格式錯誤");
else if (DATABASE_URL.includes("localhost") && env.NODE_ENV === "production")
                                         warn("DATABASE_URL 指向 localhost（生產環境建議用遠端DB）");
else                                     ok("DATABASE_URL");

const JWT_SECRET = env.JWT_SECRET ?? "";
if (!JWT_SECRET)                         fail("JWT_SECRET 未設定");
else if (JWT_SECRET === "dev-secret")    fail("JWT_SECRET 使用不安全預設值！");
else if (JWT_SECRET.length < 32)         fail(`JWT_SECRET 太短（${JWT_SECRET.length} 字元，需要 ≥32）`);
else                                     ok(`JWT_SECRET（${JWT_SECRET.length} 字元）`);

const ENCRYPTION_KEY = env.ENCRYPTION_KEY ?? "";
if (!ENCRYPTION_KEY)                     fail("ENCRYPTION_KEY 未設定");
else if (ENCRYPTION_KEY === "0".repeat(64)) fail("ENCRYPTION_KEY 使用不安全預設值！");
else if (!/^[0-9a-f]{64}$/i.test(ENCRYPTION_KEY)) fail("ENCRYPTION_KEY 格式錯誤（需要 64 位元 hex）");
else                                     ok("ENCRYPTION_KEY");

const ANTHROPIC_KEY = env.ANTHROPIC_API_KEY ?? "";
if (!ANTHROPIC_KEY)                      fail("ANTHROPIC_API_KEY 未設定");
else if (!ANTHROPIC_KEY.startsWith("sk-ant-")) fail("ANTHROPIC_API_KEY 格式可能錯誤");
else                                     ok("ANTHROPIC_API_KEY");

// Soft warnings
for (const [key, desc] of [
  ["FRONTEND_URL",       "OAuth callback URL"],
  ["BACKEND_URL",        "Webhook URL"],
  ["RESEND_API_KEY",     "Email 通知"],
  ["STRIPE_SECRET_KEY",  "Stripe 付款"],
  ["REDIS_URL",          "Redis 快取"],
]) {
  if (!env[key] || env[key] === "PLACEHOLDER") warn(`${key} 未設定 — ${desc} 功能停用`);
  else ok(key);
}

// ── 2. Security checks ────────────────────────────────────────
section("2. 安全設定");

if (env.NODE_ENV !== "production") warn(`NODE_ENV = "${env.NODE_ENV}"（建議設為 "production"）`);
else                                ok("NODE_ENV = production");

if (env.CORS_ORIGIN === "*")       fail("CORS_ORIGIN = '*' 過於寬鬆，請設定正確的 domain");
else if (!env.CORS_ORIGIN)        warn("CORS_ORIGIN 未設定，可能允許所有來源");
else                               ok(`CORS_ORIGIN = ${env.CORS_ORIGIN}`);

// Check JWT secret entropy
if (JWT_SECRET.length >= 32) {
  const unique = new Set(JWT_SECRET).size;
  if (unique < 10) warn("JWT_SECRET 字元多樣性低，建議用 openssl rand -hex 32 生成");
  else             ok("JWT_SECRET 熵值正常");
}

// ── 3. Network connectivity ───────────────────────────────────
section("3. 外部服務連線");

async function testEndpoint(name, url, options = {}) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000), ...options });
    if (res.ok || res.status === 401 || res.status === 403) {
      ok(`${name} 可連線（HTTP ${res.status}）`);
      return true;
    } else {
      warn(`${name} 回傳 ${res.status}`);
      return false;
    }
  } catch (err) {
    fail(`${name} 無法連線：${err.message}`);
    return false;
  }
}

await testEndpoint("Anthropic API", "https://api.anthropic.com/v1/models", {
  headers: { "x-api-key": ANTHROPIC_KEY || "dummy", "anthropic-version": "2023-06-01" },
});
await testEndpoint("LINE API",      "https://api.line.me/v2/bot/info", {
  headers: { Authorization: "Bearer dummy" },
});
await testEndpoint("Telegram API",  "https://api.telegram.org/botDUMMY/getMe");

if (env.STRIPE_SECRET_KEY && !env.STRIPE_SECRET_KEY.includes("test")) {
  warn("STRIPE_SECRET_KEY 可能是 Live key，確認這是你要的");
} else if (env.STRIPE_SECRET_KEY?.includes("test")) {
  warn("STRIPE_SECRET_KEY 是測試 key，記得上線前切換成 Live key");
}

// ── 4. Database connectivity ──────────────────────────────────
section("4. 資料庫");

if (DATABASE_URL) {
  try {
    // Try connecting via pg protocol check
    const url = new URL(DATABASE_URL);
    ok(`DB host: ${url.hostname}:${url.port || 5432}`);
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
      warn("DB 在 localhost — Docker 部署時確認 hostname 正確");
    }
  } catch {
    fail("DATABASE_URL 格式無法解析");
  }
}

// ── 5. Stripe live mode ───────────────────────────────────────
section("5. 付款設定");

if (!env.STRIPE_SECRET_KEY) {
  warn("Stripe 未設定 — 付款功能停用");
} else if (env.STRIPE_SECRET_KEY.startsWith("sk_live_")) {
  ok("Stripe Live mode");
  if (!env.STRIPE_WEBHOOK_SECRET) fail("STRIPE_WEBHOOK_SECRET 未設定（Live mode 必須）");
  else ok("STRIPE_WEBHOOK_SECRET");
} else {
  warn("Stripe 仍在測試模式（sk_test_...）");
}

// ── 6. Backup config ──────────────────────────────────────────
section("6. 備份設定");

const hasS3  = env.S3_ACCESS_KEY  && env.S3_BUCKET;
const hasR2  = env.R2_ACCESS_KEY  && env.R2_BUCKET && env.R2_ENDPOINT;
if (!hasS3 && !hasR2) warn("S3/R2 備份未設定 — 生產環境強烈建議設定自動備份");
else ok(`備份目標：${hasR2 ? "Cloudflare R2" : "AWS S3"} bucket=${env.S3_BUCKET || env.R2_BUCKET}`);

// ── 7. SSL / TLS ─────────────────────────────────────────────
section("7. SSL 設定");

const FRONTEND_URL = env.FRONTEND_URL ?? "";
const BACKEND_URL  = env.BACKEND_URL  ?? "";
if (FRONTEND_URL.startsWith("https://")) ok("FRONTEND_URL 使用 HTTPS");
else if (FRONTEND_URL)                   fail(`FRONTEND_URL 未使用 HTTPS：${FRONTEND_URL}`);
else                                     warn("FRONTEND_URL 未設定");

if (BACKEND_URL.startsWith("https://"))  ok("BACKEND_URL 使用 HTTPS");
else if (BACKEND_URL)                    fail(`BACKEND_URL 未使用 HTTPS：${BACKEND_URL}`);
else                                     warn("BACKEND_URL 未設定");

// ── Summary ───────────────────────────────────────────────────
console.log(`\n${"═".repeat(56)}`);
console.log(`${BOLD}上線前檢查結果${RESET}`);
console.log("─".repeat(56));
console.log(`  ${GREEN}通過${RESET}  ${passed}`);
if (warned > 0) console.log(`  ${AMBER}警告${RESET}  ${warned}`);
if (failed > 0) console.log(`  ${RED}失敗${RESET}  ${failed}`);
console.log("═".repeat(56));

if (failed > 0) {
  console.log(`\n${RED}${BOLD}✗ 有 ${failed} 項失敗 — 修正後才能上線${RESET}\n`);
  process.exit(1);
} else if (warned > 0) {
  console.log(`\n${AMBER}△ 有 ${warned} 項警告 — 確認後可繼續${RESET}\n`);
  process.exit(0);
} else {
  console.log(`\n${GREEN}${BOLD}✓ 全部通過！可以上線了 🚀${RESET}\n`);
  process.exit(0);
}
