// src/services/oauth/google.oauth.ts
// Google OAuth2 授權流程：產生授權 URL、處理 callback、交換 access token
import { prisma } from "@/db/client";
import { decryptSecret } from "@/lib/crypto";
import { storeOAuthToken } from "@/services/oauth/token.service";

// ── Scope 定義 ────────────────────────────────────────────────
export const GOOGLE_SCOPES = {
  gmail:    "https://www.googleapis.com/auth/gmail.modify",
  calendar: "https://www.googleapis.com/auth/calendar.events",
  full:     "https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar.events",
} as const;

export type GoogleScopeKey = keyof typeof GOOGLE_SCOPES;

// ── Load credentials ──────────────────────────────────────────
async function loadGoogleCredentials(workspaceId: string) {
  const [cidRow, csRow] = await Promise.all([
    prisma.secret.findUnique({
      where: { workspaceId_name: { workspaceId, name: "GOOGLE_CLIENT_ID" } },
    }),
    prisma.secret.findUnique({
      where: { workspaceId_name: { workspaceId, name: "GOOGLE_CLIENT_SECRET" } },
    }),
  ]);

  const clientId = cidRow?.encryptedValue.startsWith("PLACEHOLDER")
    ? (process.env.GOOGLE_CLIENT_ID ?? "")
    : cidRow ? decryptSecret(cidRow.encryptedValue) : "";

  const clientSecret = csRow?.encryptedValue.startsWith("PLACEHOLDER")
    ? (process.env.GOOGLE_CLIENT_SECRET ?? "")
    : csRow ? decryptSecret(csRow.encryptedValue) : "";

  return { clientId, clientSecret };
}

// ── Build authorization URL ───────────────────────────────────
export async function buildGoogleAuthUrl(params: {
  workspaceId: string;
  scopeKey:    GoogleScopeKey;
  redirectUri: string;
  state?:      string;
}): Promise<string> {
  const { clientId } = await loadGoogleCredentials(params.workspaceId);
  if (!clientId) throw new Error("GOOGLE_CLIENT_ID not configured");

  const scope      = GOOGLE_SCOPES[params.scopeKey];
  const statePayload = Buffer.from(JSON.stringify({
    workspaceId: params.workspaceId,
    scopeKey:    params.scopeKey,
    extra:       params.state,
  })).toString("base64url");

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id",     clientId);
  url.searchParams.set("redirect_uri",  params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope",         scope);
  url.searchParams.set("access_type",   "offline");      // get refresh_token
  url.searchParams.set("prompt",        "consent");      // force re-consent to get refresh_token
  url.searchParams.set("state",         statePayload);

  return url.toString();
}

// ── Exchange authorization code for tokens ────────────────────
export async function exchangeGoogleCode(params: {
  code:        string;
  redirectUri: string;
  state:       string;                  // base64url encoded state from buildGoogleAuthUrl
}): Promise<{
  workspaceId: string;
  scopeKey:    GoogleScopeKey;
  tokenId:     string;
  userEmail:   string;
}> {
  const stateData = JSON.parse(Buffer.from(params.state, "base64url").toString());
  const { workspaceId, scopeKey } = stateData;

  const { clientId, clientSecret } = await loadGoogleCredentials(workspaceId);

  // Exchange code for tokens
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code:          params.code,
      client_id:     clientId,
      client_secret: clientSecret,
      redirect_uri:  params.redirectUri,
      grant_type:    "authorization_code",
    }),
    signal: AbortSignal.timeout(10_000),
  });

  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description ?? data.error ?? "Token exchange failed");
  }

  // Get user email from userinfo
  let userEmail = "";
  try {
    const uRes  = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${data.access_token}` },
    });
    const uData = await uRes.json();
    userEmail   = uData.email ?? "";
  } catch { /* optional */ }

  const tokenId = await storeOAuthToken(workspaceId, "GOOGLE", GOOGLE_SCOPES[scopeKey], {
    accessToken:  data.access_token,
    refreshToken: data.refresh_token,
    expiresIn:    data.expires_in ?? 3600,
    scope:        data.scope,
    userEmail,
  });

  await prisma.logEntry.create({
    data: {
      workspaceId,
      type:    "SYSTEM",
      message: `[OAuth] Google ${scopeKey} 授權完成（${userEmail}）`,
    },
  });

  return { workspaceId, scopeKey, tokenId, userEmail };
}
