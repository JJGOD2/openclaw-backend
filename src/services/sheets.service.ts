// src/services/sheets.service.ts
// Google Sheets 整合：讀取、寫入、查詢指定試算表
// 使用 Google Sheets API v4（Service Account 認證）
import { prisma } from "@/db/client";
import { decryptSecret } from "@/lib/crypto";

// ── 取得 Google Access Token (Service Account JWT) ───────────
async function getAccessToken(serviceAccountJson: string): Promise<string> {
  const sa = JSON.parse(serviceAccountJson);
  const now = Math.floor(Date.now() / 1000);

  const header  = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })).toString("base64url");

  // Sign with private key using Node crypto
  const { createSign } = await import("crypto");
  const sign = createSign("RSA-SHA256");
  sign.update(`${header}.${payload}`);
  const signature = sign.sign(sa.private_key, "base64url");

  const jwt = `${header}.${payload}.${signature}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion:  jwt,
    }),
  });

  const data = await res.json();
  if (!data.access_token) throw new Error(`Google auth failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

// ── Load sheets credentials for workspace ────────────────────
async function loadSheetsToken(workspaceId: string): Promise<string> {
  const secret = await prisma.secret.findUnique({
    where: { workspaceId_name: { workspaceId, name: "GOOGLE_SERVICE_ACCOUNT_JSON" } },
  });
  if (!secret) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON not configured for workspace");

  const saJson = secret.encryptedValue.startsWith("PLACEHOLDER")
    ? process.env.GOOGLE_SERVICE_ACCOUNT_JSON ?? ""
    : decryptSecret(secret.encryptedValue);

  return getAccessToken(saJson);
}

// ── Read range from spreadsheet ──────────────────────────────
export async function sheetsRead(
  workspaceId:   string,
  spreadsheetId: string,
  range:         string
): Promise<string[][]> {
  const token = await loadSheetsToken(workspaceId);
  const url   = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`;

  const res  = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (!res.ok) throw new Error(`Sheets read error: ${JSON.stringify(data)}`);

  return (data.values as string[][]) ?? [];
}

// ── Append rows to spreadsheet ───────────────────────────────
export async function sheetsAppend(
  workspaceId:   string,
  spreadsheetId: string,
  range:         string,
  values:        (string | number)[][]
): Promise<{ updatedRows: number }> {
  const token = await loadSheetsToken(workspaceId);
  const url   = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`;

  const res  = await fetch(url, {
    method:  "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body:    JSON.stringify({ values }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Sheets append error: ${JSON.stringify(data)}`);

  return { updatedRows: data.updates?.updatedRows ?? values.length };
}

// ── Write/update a specific range ────────────────────────────
export async function sheetsWrite(
  workspaceId:   string,
  spreadsheetId: string,
  range:         string,
  values:        (string | number)[][]
): Promise<{ updatedCells: number }> {
  const token = await loadSheetsToken(workspaceId);
  const url   = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;

  const res  = await fetch(url, {
    method:  "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body:    JSON.stringify({ values }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Sheets write error: ${JSON.stringify(data)}`);

  return { updatedCells: data.updatedCells ?? 0 };
}

// ── Log a conversation turn to Sheets ────────────────────────
export async function logConversationToSheets(
  workspaceId:   string,
  spreadsheetId: string,
  sheetName:     string,
  entry: {
    timestamp:  string;
    platform:   string;
    userId:     string;
    agentName:  string;
    userMsg:    string;
    agentReply: string;
    reviewStatus?: string;
  }
): Promise<void> {
  const row = [
    entry.timestamp,
    entry.platform,
    entry.userId,
    entry.agentName,
    entry.userMsg,
    entry.agentReply,
    entry.reviewStatus ?? "auto",
  ];

  await sheetsAppend(workspaceId, spreadsheetId, `${sheetName}!A:G`, [row]);
}
