// src/routes/admin/webhooks.ts
import { Router } from "express";
import { z } from "zod";
import crypto from "crypto";
import { prisma } from "@/db/client";
import { requireAuth } from "@/middleware/auth";
import { AppError } from "@/middleware/errorHandler";

const router = Router();
router.use(requireAuth);

const SUPPORTED_EVENTS = [
  "log.error",       "log.warn",
  "review.pending",  "review.approved",  "review.rejected",
  "gateway.push_ok", "gateway.push_fail",
  "security.fail",   "security.warn",
  "usage.threshold",
  "agent.error",
  "channel.disconnect",
];

// ── GET /api/admin/webhooks ──────────────────────────────────
router.get("/", async (req, res, next) => {
  try {
    const { workspaceId } = req.query;
    const endpoints = await prisma.webhookEndpoint.findMany({
      where: workspaceId ? { workspaceId: String(workspaceId) } : {},
      orderBy: { createdAt: "desc" },
    });
    res.json(endpoints);
  } catch (e) { next(e); }
});

// ── GET /api/admin/webhooks/events  — 支援的事件清單 ────────
router.get("/events", (_req, res) => res.json(SUPPORTED_EVENTS));

// ── POST /api/admin/webhooks ─────────────────────────────────
router.post("/", async (req, res, next) => {
  try {
    const Schema = z.object({
      workspaceId: z.string().cuid().optional().nullable(),
      name:        z.string().min(1).max(80),
      url:         z.string().url(),
      events:      z.array(z.string()).min(1),
    });
    const body = Schema.safeParse(req.body);
    if (!body.success) throw new AppError(400, body.error.message);

    const secret   = crypto.randomBytes(24).toString("hex");
    const endpoint = await prisma.webhookEndpoint.create({
      data: { ...body.data, secret },
    });
    // Return secret ONCE
    res.status(201).json({ ...endpoint, webhookSecret: secret });
  } catch (e) { next(e); }
});

// ── PATCH /api/admin/webhooks/:id ────────────────────────────
router.patch("/:id", async (req, res, next) => {
  try {
    const Schema = z.object({
      name:    z.string().optional(),
      url:     z.string().url().optional(),
      events:  z.array(z.string()).optional(),
      enabled: z.boolean().optional(),
    });
    const body = Schema.safeParse(req.body);
    if (!body.success) throw new AppError(400, body.error.message);
    const ep = await prisma.webhookEndpoint.update({ where: { id: req.params.id }, data: body.data });
    res.json(ep);
  } catch (e) { next(e); }
});

// ── DELETE /api/admin/webhooks/:id ───────────────────────────
router.delete("/:id", async (req, res, next) => {
  try {
    await prisma.webhookEndpoint.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (e) { next(e); }
});

// ── GET /api/admin/webhooks/:id/deliveries ───────────────────
router.get("/:id/deliveries", async (req, res, next) => {
  try {
    const deliveries = await prisma.webhookDelivery.findMany({
      where:   { endpointId: req.params.id },
      orderBy: { deliveredAt: "desc" },
      take:    50,
    });
    res.json(deliveries);
  } catch (e) { next(e); }
});

// ── POST /api/admin/webhooks/:id/test ────────────────────────
router.post("/:id/test", async (req, res, next) => {
  try {
    const ep = await prisma.webhookEndpoint.findUnique({ where: { id: req.params.id } });
    if (!ep) throw new AppError(404, "Endpoint not found");

    const result = await deliver(ep.id, ep.url, ep.secret, "webhook.test", {
      message: "這是一封測試 Webhook，確認端點設定正確。",
      ts:      new Date().toISOString(),
    });
    res.json(result);
  } catch (e) { next(e); }
});

// ── Delivery engine ──────────────────────────────────────────
export async function deliver(
  endpointId: string,
  url:        string,
  secret:     string,
  event:      string,
  payload:    object
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const body      = JSON.stringify({ event, payload, ts: new Date().toISOString() });
  const signature = crypto.createHmac("sha256", secret).update(body).digest("hex");

  try {
    const res = await fetch(url, {
      method:  "POST",
      headers: {
        "Content-Type":          "application/json",
        "X-MyWrapper-Event":      event,
        "X-MyWrapper-Signature":  `sha256=${signature}`,
        "X-OpenClaw-Delivery":   crypto.randomUUID(),
      },
      body,
      signal: AbortSignal.timeout(10000),
    });

    const ok           = res.status >= 200 && res.status < 300;
    const responseBody = await res.text().catch(() => "");

    await prisma.webhookDelivery.create({
      data: { endpointId, event, payload, responseStatus: res.status, responseBody, ok },
    });

    if (!ok) {
      await prisma.webhookEndpoint.update({
        where: { id: endpointId },
        data:  { failCount: { increment: 1 } },
      });
    } else {
      await prisma.webhookEndpoint.update({
        where: { id: endpointId },
        data:  { lastFiredAt: new Date(), failCount: 0 },
      });
    }

    return { ok, status: res.status };
  } catch (err) {
    const error = (err as Error).message;
    await prisma.webhookDelivery.create({
      data: { endpointId, event, payload, ok: false, responseBody: error },
    });
    await prisma.webhookEndpoint.update({
      where: { id: endpointId },
      data:  { failCount: { increment: 1 } },
    }).catch(() => {});
    return { ok: false, error };
  }
}

// ── Fan-out: fire all matching webhook endpoints ─────────────
export async function fireWebhooks(
  workspaceId: string | null,
  event:       string,
  payload:     object
): Promise<void> {
  const endpoints = await prisma.webhookEndpoint.findMany({
    where: {
      enabled: true,
      events:  { has: event },
      OR: [
        { workspaceId: null },
        ...(workspaceId ? [{ workspaceId }] : []),
      ],
    },
  });

  await Promise.allSettled(
    endpoints.map((ep) => deliver(ep.id, ep.url, ep.secret, event, payload))
  );
}

export default router;
