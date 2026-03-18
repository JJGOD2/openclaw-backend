// src/services/oauth/token.service.ts
// OAuth2 Token 管理：儲存、自動換票、有效性檢查
import { prisma } from "@/db/client";
import { encryptSecret, decryptSecret } from "@/lib/crypto";
import { OAuthProvider } from "@prisma/client";

// ── Token 到期前多少秒開始換票（提前緩衝）────────────────────
const REFRESH_BUFFER_SECONDS = 300;   // 5 分鐘

// ── 連續換票失敗幾次後標記為 invalid ─────────────────────────
const MAX_REFRESH_FAILURES = 3;

export interface TokenData {
  accessToken:  string;
  refreshToken?: string;
  expiresIn:    number;       // seconds
  scope?:       string;
  userEmail?:   string;
}

// ─────────────────────────────────────────────────────────────
// 儲存 Token（初次授權後呼叫）
// ─────────────────────────────────────────────────────────────
export async function storeOAuthToken(
  workspaceId: string,
  provider:    OAuthProvider,
  scope:       string,
  data:        TokenData
): Promise<string> {
  const expiresAt = new Date(Date.now() + data.expiresIn * 1000);

  const record = await prisma.oAuthToken.upsert({
    where:  { workspaceId_provider_scope: { workspaceId, provider, scope } },
    update: {
      encryptedAccessToken:  encryptSecret(data.accessToken),
      encryptedRefreshToken: data.refreshToken ? encryptSecret(data.refreshToken) : undefined,
      expiresAt,
      isValid:          true,
      refreshFailCount: 0,
      lastRefreshedAt:  new Date(),
      userEmail:        data.userEmail,
    },
    create: {
      workspaceId,
      provider,
      scope,
      encryptedAccessToken:  encryptSecret(data.accessToken),
      encryptedRefreshToken: data.refreshToken ? encryptSecret(data.refreshToken) : undefined,
      expiresAt,
      userEmail:  data.userEmail,
      isValid:    true,
    },
  });

  return record.id;
}

// ─────────────────────────────────────────────────────────────
// 取得有效 Access Token（自動換票）
// ─────────────────────────────────────────────────────────────
export async function getValidAccessToken(
  workspaceId: string,
  provider:    OAuthProvider,
  scope:       string
): Promise<string> {
  const record = await prisma.oAuthToken.findUnique({
    where: { workspaceId_provider_scope: { workspaceId, provider, scope } },
  });

  if (!record) {
    throw new OAuthNotConfiguredError(provider, scope);
  }

  if (!record.isValid) {
    throw new OAuthInvalidError(provider, record.refreshFailCount);
  }

  const nowPlusBuffer = new Date(Date.now() + REFRESH_BUFFER_SECONDS * 1000);
  const needsRefresh  = record.expiresAt <= nowPlusBuffer;

  if (!needsRefresh) {
    return decryptSecret(record.encryptedAccessToken);
  }

  // ── Token 即將到期，換票 ──────────────────────────────────
  if (!record.encryptedRefreshToken) {
    throw new OAuthExpiredError(provider);
  }

  const refreshToken = decryptSecret(record.encryptedRefreshToken);

  try {
    const refresher = REFRESHERS[provider];
    if (!refresher) throw new Error(`No refresher for provider: ${provider}`);

    const newTokens = await refresher(refreshToken, workspaceId);

    // 更新 DB
    await prisma.oAuthToken.update({
      where: { id: record.id },
      data: {
        encryptedAccessToken:  encryptSecret(newTokens.accessToken),
        encryptedRefreshToken: newTokens.refreshToken
          ? encryptSecret(newTokens.refreshToken)
          : record.encryptedRefreshToken,            // Google 不一定每次都回傳新的 refresh token
        expiresAt:        new Date(Date.now() + newTokens.expiresIn * 1000),
        isValid:          true,
        refreshFailCount: 0,
        lastRefreshedAt:  new Date(),
      },
    });

    await prisma.logEntry.create({
      data: {
        workspaceId,
        type:    "SYSTEM",
        message: `[OAuth] ${provider} token 自動換票成功`,
      },
    });

    return newTokens.accessToken;

  } catch (err) {
    const failCount = record.refreshFailCount + 1;
    const shouldInvalidate = failCount >= MAX_REFRESH_FAILURES;

    await prisma.oAuthToken.update({
      where: { id: record.id },
      data: {
        refreshFailCount: failCount,
        isValid:          !shouldInvalidate,
      },
    });

    await prisma.logEntry.create({
      data: {
        workspaceId,
        type:    "ERROR",
        message: `[OAuth] ${provider} 換票失敗（第 ${failCount} 次）：${(err as Error).message}` +
          (shouldInvalidate ? " — Token 已標記為無效，請重新授權" : ""),
      },
    });

    // 換票失敗但 token 還沒過期 → 繼續用舊的
    if (record.expiresAt > new Date()) {
      return decryptSecret(record.encryptedAccessToken);
    }

    throw new OAuthRefreshError(provider, (err as Error).message);
  }
}

// ─────────────────────────────────────────────────────────────
// 查詢 token 狀態（不觸發換票）
// ─────────────────────────────────────────────────────────────
export async function getTokenStatus(
  workspaceId: string,
  provider:    OAuthProvider,
  scope:       string
): Promise<{
  exists:    boolean;
  isValid:   boolean;
  expiresAt: Date | null;
  expiresIn: number;           // seconds, negative = already expired
  needsRefresh: boolean;
  userEmail: string | null;
  refreshFailCount: number;
}> {
  const record = await prisma.oAuthToken.findUnique({
    where: { workspaceId_provider_scope: { workspaceId, provider, scope } },
  });

  if (!record) {
    return { exists:false, isValid:false, expiresAt:null, expiresIn:0,
             needsRefresh:false, userEmail:null, refreshFailCount:0 };
  }

  const expiresIn    = Math.floor((record.expiresAt.getTime() - Date.now()) / 1000);
  const needsRefresh = expiresIn < REFRESH_BUFFER_SECONDS;

  return {
    exists:    true,
    isValid:   record.isValid,
    expiresAt: record.expiresAt,
    expiresIn,
    needsRefresh,
    userEmail: record.userEmail,
    refreshFailCount: record.refreshFailCount,
  };
}

// ─────────────────────────────────────────────────────────────
// 撤銷 token
// ─────────────────────────────────────────────────────────────
export async function revokeOAuthToken(
  workspaceId: string,
  provider:    OAuthProvider,
  scope:       string
): Promise<void> {
  const record = await prisma.oAuthToken.findUnique({
    where: { workspaceId_provider_scope: { workspaceId, provider, scope } },
  });
  if (!record) return;

  // 呼叫 Google revoke endpoint
  if (provider === "GOOGLE" && record.encryptedRefreshToken) {
    const refreshToken = decryptSecret(record.encryptedRefreshToken);
    await fetch(
      `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refreshToken)}`,
      { method: "POST" }
    ).catch(() => {});   // best-effort
  }

  await prisma.oAuthToken.delete({ where: { id: record.id } });
}

// ─────────────────────────────────────────────────────────────
// Provider-specific refreshers
// ─────────────────────────────────────────────────────────────
type Refresher = (refreshToken: string, workspaceId: string) => Promise<TokenData>;

const REFRESHERS: Partial<Record<OAuthProvider, Refresher>> = {
  GOOGLE: refreshGoogleToken,
};

async function refreshGoogleToken(
  refreshToken: string,
  workspaceId:  string
): Promise<TokenData> {
  // Load client credentials from workspace secrets
  const [clientIdRow, clientSecretRow] = await Promise.all([
    prisma.secret.findUnique({
      where: { workspaceId_name: { workspaceId, name: "GOOGLE_CLIENT_ID" } },
    }),
    prisma.secret.findUnique({
      where: { workspaceId_name: { workspaceId, name: "GOOGLE_CLIENT_SECRET" } },
    }),
  ]);

  const clientId     = clientIdRow?.encryptedValue.startsWith("PLACEHOLDER")
    ? (process.env.GOOGLE_CLIENT_ID ?? "")
    : clientIdRow ? decryptSecret(clientIdRow.encryptedValue) : "";

  const clientSecret = clientSecretRow?.encryptedValue.startsWith("PLACEHOLDER")
    ? (process.env.GOOGLE_CLIENT_SECRET ?? "")
    : clientSecretRow ? decryptSecret(clientSecretRow.encryptedValue) : "";

  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID 或 GOOGLE_CLIENT_SECRET 未設定");
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id:     clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type:    "refresh_token",
    }),
    signal: AbortSignal.timeout(10_000),
  });

  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description ?? data.error ?? "Unknown refresh error");
  }

  return {
    accessToken:  data.access_token,
    refreshToken: data.refresh_token,   // Google may or may not return new refresh_token
    expiresIn:    data.expires_in ?? 3600,
    scope:        data.scope,
  };
}

// ─────────────────────────────────────────────────────────────
// Custom Errors
// ─────────────────────────────────────────────────────────────
export class OAuthNotConfiguredError extends Error {
  constructor(provider: string, scope: string) {
    super(`${provider} OAuth token not configured (scope: ${scope})`);
    this.name = "OAuthNotConfiguredError";
  }
}
export class OAuthExpiredError extends Error {
  constructor(provider: string) {
    super(`${provider} access token expired and no refresh token available`);
    this.name = "OAuthExpiredError";
  }
}
export class OAuthRefreshError extends Error {
  constructor(provider: string, detail: string) {
    super(`${provider} token refresh failed: ${detail}`);
    this.name = "OAuthRefreshError";
  }
}
export class OAuthInvalidError extends Error {
  constructor(provider: string, failCount: number) {
    super(`${provider} token marked invalid after ${failCount} refresh failures — please re-authorize`);
    this.name = "OAuthInvalidError";
  }
}
