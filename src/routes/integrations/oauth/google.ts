// src/routes/integrations/oauth/google.ts
// Google OAuth2 授權流程端點
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "@/middleware/auth";
import { AppError } from "@/middleware/errorHandler";
import {
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  GOOGLE_SCOPES,
  type GoogleScopeKey,
} from "@/services/oauth/google.oauth";
import {
  getTokenStatus,
  revokeOAuthToken,
} from "@/services/oauth/token.service";

const router = Router();

const REDIRECT_URI = `${process.env.BACKEND_URL ?? "http://localhost:4000"}/api/oauth/google/callback`;

// ── GET /api/oauth/google/auth-url?workspaceId=&scope= ────────
// 產生授權 URL，前端跳轉用
router.get("/auth-url", requireAuth, async (req, res, next) => {
  try {
    const { workspaceId, scope } = z.object({
      workspaceId: z.string().cuid(),
      scope:       z.enum(["gmail","calendar","full"]),
    }).parse(req.query);

    const url = await buildGoogleAuthUrl({
      workspaceId,
      scopeKey:    scope as GoogleScopeKey,
      redirectUri: REDIRECT_URI,
    });
    res.json({ url });
  } catch (e) { next(e); }
});

// ── GET /api/oauth/google/callback ────────────────────────────
// Google 授權後回調（處理 code exchange）
router.get("/callback", async (req, res, next) => {
  try {
    const { code, state, error } = req.query as Record<string, string>;

    if (error) {
      return res.redirect(
        `${process.env.FRONTEND_URL ?? "http://localhost:3000"}/integrations?oauth_error=${encodeURIComponent(error)}`
      );
    }
    if (!code || !state) throw new AppError(400, "Missing code or state");

    const result = await exchangeGoogleCode({ code, redirectUri: REDIRECT_URI, state });

    // 回跳前端，帶成功訊息
    return res.redirect(
      `${process.env.FRONTEND_URL ?? "http://localhost:3000"}/integrations/${result.scopeKey}?oauth_success=1&email=${encodeURIComponent(result.userEmail)}`
    );
  } catch (e) { next(e); }
});

// ── GET /api/oauth/google/status?workspaceId=&scope= ─────────
router.get("/status", requireAuth, async (req, res, next) => {
  try {
    const { workspaceId, scope } = z.object({
      workspaceId: z.string().cuid(),
      scope:       z.enum(["gmail","calendar","full"]),
    }).parse(req.query);

    const scopeStr = GOOGLE_SCOPES[scope as GoogleScopeKey];
    const status   = await getTokenStatus(workspaceId, "GOOGLE", scopeStr);

    res.json({
      ...status,
      scopeKey:  scope,
      expiresInMinutes: status.expiresIn > 0 ? Math.floor(status.expiresIn / 60) : 0,
    });
  } catch (e) { next(e); }
});

// ── GET /api/oauth/google/status/all?workspaceId= ─────────────
// 一次查所有 scope 的狀態
router.get("/status/all", requireAuth, async (req, res, next) => {
  try {
    const { workspaceId } = z.object({ workspaceId: z.string().cuid() }).parse(req.query);

    const scopes: GoogleScopeKey[] = ["gmail","calendar","full"];
    const statuses = await Promise.all(
      scopes.map(async (s) => {
        const status = await getTokenStatus(workspaceId, "GOOGLE", GOOGLE_SCOPES[s]);
        return { scope: s, ...status, expiresInMinutes: Math.max(0, Math.floor(status.expiresIn / 60)) };
      })
    );
    res.json(statuses);
  } catch (e) { next(e); }
});

// ── DELETE /api/oauth/google/revoke ───────────────────────────
router.delete("/revoke", requireAuth, async (req, res, next) => {
  try {
    const { workspaceId, scope } = z.object({
      workspaceId: z.string().cuid(),
      scope:       z.enum(["gmail","calendar","full"]),
    }).parse(req.body);

    await revokeOAuthToken(workspaceId, "GOOGLE", GOOGLE_SCOPES[scope as GoogleScopeKey]);
    res.json({ ok: true, message: `Google ${scope} 授權已撤銷` });
  } catch (e) { next(e); }
});

export default router;
