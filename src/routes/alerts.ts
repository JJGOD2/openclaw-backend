// src/routes/alerts.ts
import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/db/client";
import { requireAuth } from "@/middleware/auth";
import { AppError } from "@/middleware/errorHandler";
import { AlertChannel, AlertTrigger } from "@prisma/client";

const router = Router();
router.use(requireAuth);

const RuleSchema = z.object({
  workspaceId: z.string().cuid().optional().nullable(),
  name:        z.string().min(1).max(80),
  trigger:     z.nativeEnum(AlertTrigger),
  channel:     z.nativeEnum(AlertChannel),
  destination: z.string().min(1),
  threshold:   z.number().optional(),
  enabled:     z.boolean().optional(),
});

// GET /api/alerts/rules?workspaceId=
router.get("/rules", async (req, res, next) => {
  try {
    const { workspaceId } = req.query;
    const rules = await prisma.alertRule.findMany({
      where: {
        OR: [
          { workspaceId: null },
          ...(workspaceId ? [{ workspaceId: String(workspaceId) }] : []),
        ],
      },
      orderBy: { createdAt: "desc" },
    });
    res.json(rules);
  } catch (e) { next(e); }
});

// POST /api/alerts/rules
router.post("/rules", async (req, res, next) => {
  try {
    const body = RuleSchema.safeParse(req.body);
    if (!body.success) throw new AppError(400, body.error.message);
    const rule = await prisma.alertRule.create({ data: body.data });
    res.status(201).json(rule);
  } catch (e) { next(e); }
});

// PATCH /api/alerts/rules/:id
router.patch("/rules/:id", async (req, res, next) => {
  try {
    const body = RuleSchema.partial().safeParse(req.body);
    if (!body.success) throw new AppError(400, body.error.message);
    const rule = await prisma.alertRule.update({ where: { id: req.params.id }, data: body.data });
    res.json(rule);
  } catch (e) { next(e); }
});

// DELETE /api/alerts/rules/:id
router.delete("/rules/:id", async (req, res, next) => {
  try {
    await prisma.alertRule.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (e) { next(e); }
});

// GET /api/alerts/logs?workspaceId=
router.get("/logs", async (req, res, next) => {
  try {
    const logs = await prisma.alertLog.findMany({
      orderBy: { sentAt: "desc" },
      take: 50,
    });
    res.json(logs);
  } catch (e) { next(e); }
});

// POST /api/alerts/test/:ruleId — 測試發送
router.post("/test/:ruleId", async (req, res, next) => {
  try {
    const rule = await prisma.alertRule.findUnique({ where: { id: req.params.ruleId } });
    if (!rule) throw new AppError(404, "Rule not found");

    const result = await dispatch(rule.channel, rule.destination, {
      title:   `[測試] ${rule.name}`,
      message: "這是一封測試告警，用於確認通道設定正確。",
    });

    res.json({ ok: result.ok, message: result.message });
  } catch (e) { next(e); }
});

// ── Dispatcher ────────────────────────────────────────────────
interface DispatchPayload { title: string; message: string; }
async function dispatch(
  channel:     AlertChannel,
  destination: string,
  payload:     DispatchPayload
): Promise<{ ok: boolean; message: string }> {
  try {
    if (channel === "SLACK_WEBHOOK") {
      const r = await fetch(destination, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ text: `*${payload.title}*\n${payload.message}` }),
        signal:  AbortSignal.timeout(5000),
      });
      return { ok: r.ok, message: r.ok ? "已發送至 Slack" : `Slack 回應錯誤：${r.status}` };
    }

    if (channel === "LINE_NOTIFY") {
      const r = await fetch("https://notify-api.line.me/api/notify", {
        method:  "POST",
        headers: {
          "Content-Type":  "application/x-www-form-urlencoded",
          "Authorization": `Bearer ${destination}`,
        },
        body:   `message=${encodeURIComponent(`${payload.title}\n${payload.message}`)}`,
        signal: AbortSignal.timeout(5000),
      });
      return { ok: r.ok, message: r.ok ? "已發送至 LINE Notify" : `LINE Notify 失敗：${r.status}` };
    }

    // EMAIL — placeholder (integrate SendGrid / Resend in production)
    if (channel === "EMAIL") {
      console.log(`[EMAIL] To: ${destination}\n${payload.title}\n${payload.message}`);
      return { ok: true, message: `Email 已排程發送至 ${destination}（Dev 模式：僅 log）` };
    }

    return { ok: false, message: `未支援的通道：${channel}` };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

// Export for use in cron / event listeners
export { dispatch };
export default router;
