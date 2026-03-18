// src/routes/billing/index.ts
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "@/middleware/auth";
import { AppError } from "@/middleware/errorHandler";
import {
  createCheckoutSession,
  createPortalSession,
  getSubscriptionStatus,
  handleStripeWebhook,
} from "@/services/billing/stripe.service";

const router = Router();

// ── GET /api/billing/status?workspaceId= ──────────────────────
router.get("/status", requireAuth, async (req, res, next) => {
  try {
    const { workspaceId } = z.object({ workspaceId: z.string().cuid() }).parse(req.query);
    const status = await getSubscriptionStatus(workspaceId);
    res.json(status);
  } catch (e) { next(e); }
});

// ── POST /api/billing/checkout ────────────────────────────────
router.post("/checkout", requireAuth, async (req, res, next) => {
  try {
    const body = z.object({
      workspaceId: z.string().cuid(),
      plan:        z.enum(["STARTER","PRO"]),
      email:       z.string().email(),
      trialDays:   z.number().optional(),
    }).parse(req.body);

    const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:3000";
    const result = await createCheckoutSession({
      ...body,
      successUrl: `${frontendUrl}/billing?success=1&workspace=${body.workspaceId}`,
      cancelUrl:  `${frontendUrl}/billing?canceled=1`,
    });
    res.json(result);
  } catch (e) { next(e); }
});

// ── POST /api/billing/portal ──────────────────────────────────
router.post("/portal", requireAuth, async (req, res, next) => {
  try {
    const { workspaceId } = z.object({ workspaceId: z.string().cuid() }).parse(req.body);
    const frontendUrl     = process.env.FRONTEND_URL ?? "http://localhost:3000";
    const url             = await createPortalSession({
      workspaceId,
      returnUrl: `${frontendUrl}/billing?workspace=${workspaceId}`,
    });
    res.json({ url });
  } catch (e) { next(e); }
});

// ── POST /api/billing/webhook ─────────────────────────────────
// Stripe Webhook（raw body 必須在 index.ts 處理）
router.post("/webhook", async (req, res, next) => {
  try {
    const signature = req.headers["stripe-signature"] as string;
    if (!signature) throw new AppError(400, "Missing stripe-signature header");

    const rawBody = typeof req.body === "string"
      ? req.body
      : JSON.stringify(req.body);

    await handleStripeWebhook(rawBody, signature);
    res.json({ received: true });
  } catch (e) {
    console.error("[Stripe Webhook]", e);
    res.status(400).json({ error: (e as Error).message });
  }
});

export default router;
