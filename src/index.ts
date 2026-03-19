import "dotenv/config";
import http    from "http";
import express from "express";

// ── Core lib ──────────────────────────────────────────────────
import { validateEnv, setupGracefulShutdown } from "@/lib/startup";
import { requestId }          from "@/middleware/requestId";
import { initRedis }          from "@/lib/cache/redis";
import { initTelemetry }      from "@/lib/observability/telemetry";
import { featureFlagMiddleware } from "@/lib/flags/feature-flags";
import { apiLimiter, authLimiter, webhookLimiter, publicApiLimiter } from "@/middleware/rateLimit";
import { errorHandler }       from "@/middleware/errorHandler";
import { attachWebSocket }    from "@/lib/websocket";
import { startScheduler }     from "@/jobs/scheduler";

// ── Routes ────────────────────────────────────────────────────
import authRoutes         from "@/routes/auth";
import workspaceRoutes    from "@/routes/workspaces";
import restoreRoutes      from "@/routes/workspaces.restore";
import agentRoutes        from "@/routes/agents";
import channelRoutes      from "@/routes/channels";
import toolRoutes         from "@/routes/tools";
import secretRoutes       from "@/routes/secrets";
import securityRoutes     from "@/routes/security";
import logRoutes          from "@/routes/logs";
import usageRoutes        from "@/routes/usage";
import reviewRoutes       from "@/routes/review";
import reviewCommentRoutes from "@/routes/review-comments";
import gatewayRoutes      from "@/routes/gateway";
import templateRoutes     from "@/routes/templates";
import alertRoutes        from "@/routes/alerts";
import whitelabelRoutes   from "@/routes/whitelabel";
import sessionRoutes      from "@/routes/sessions";
import publicApiRoutes    from "@/routes/public-api";
import billingRoutes      from "@/routes/billing";
import analyticsRoutes    from "@/routes/analytics";
import metricsRouter      from "@/routes/metrics";
import portalRoutes       from "@/routes/portal";
import auditRoutes        from "@/routes/audit";
import playgroundRoutes   from "@/routes/playground";
import promptVersionRoutes from "@/routes/prompt-versions";
import slaRoutes          from "@/routes/sla";
import bulkRoutes         from "@/routes/bulk";
import modelsRoutes       from "@/routes/models";
import exportRoutes       from "@/routes/export";
import toolBuilderRoutes  from "@/routes/tool-builder";
import knowledgeRoutes    from "@/routes/knowledge";
import abTestRoutes       from "@/routes/ab-test";
import flowRoutes         from "@/routes/flows";
import broadcastRoutes    from "@/routes/broadcast";
import segmentRoutes      from "@/routes/segments";
import handoffRoutes      from "@/routes/handoff";
import satisfactionRoutes from "@/routes/satisfaction";
import formRoutes         from "@/routes/forms";
import logSearchRoutes    from "@/routes/log-search";
import mediaRoutes        from "@/routes/media";
import chainRoutes        from "@/routes/chains";
import superAdminRoutes   from "@/routes/super-admin";
import securityToolsRoutes from "@/routes/security-tools";
import featureFlagRoutes  from "@/routes/feature-flags";
import orchestrationRoutes from "@/routes/orchestration";
import notificationRoutes from "@/routes/notifications";
import marketplaceRoutes  from "@/routes/marketplace";
import securityScanRoutes from "@/routes/security-scan";

// Admin
import permissionRoutes   from "@/routes/admin/permissions";
import apiKeyRoutes       from "@/routes/admin/api-keys";
import webhookAdminRoutes from "@/routes/admin/webhooks";

// Integrations
import googleOAuthRoutes  from "@/routes/integrations/oauth/google";
import sheetsRoutes       from "@/routes/integrations/sheets";
import notionRoutes       from "@/routes/integrations/notion";
import gmailRoutes        from "@/routes/integrations/gmail";
import gcalRoutes         from "@/routes/integrations/gcal";

// Webhooks
import lineWebhook        from "@/routes/webhooks/line";
import tgWebhook          from "@/routes/webhooks/telegram";
import slackWebhook       from "@/routes/webhooks/slack";
import discordWebhook     from "@/routes/webhooks/discord";
import whatsappWebhook    from "@/routes/webhooks/whatsapp";
import twilioWebhook      from "@/routes/webhooks/twilio";

// Quotas
import { quotaRouter }    from "@/lib/quotas";

// ─────────────────────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────────────────────
validateEnv();
initTelemetry();

const app    = express();
const server = http.createServer(app);
const PORT   = Number(process.env.PORT ?? 4000);

// ── Raw body for webhook signature verification ───────────────
const rawBodyPaths = [
  "/webhook/line", "/webhook/telegram", "/webhook/slack",
  "/webhook/discord", "/webhook/whatsapp", "/api/billing/webhook",
];
app.use(rawBodyPaths, express.raw({ type: "application/json" }),
  (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    if (Buffer.isBuffer(req.body)) req.body = JSON.parse(req.body.toString("utf-8"));
    next();
  }
);

// ── Global middleware ─────────────────────────────────────────
app.use(requestId());
app.use(featureFlagMiddleware());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// CORS
app.use((req, res, next) => {
  const origin = process.env.CORS_ORIGIN ?? "http://localhost:3000";
  res.setHeader("Access-Control-Allow-Origin",  origin);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,X-Api-Key,X-Request-Id");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Global rate limit
app.use("/api", apiLimiter);

// ── Health ────────────────────────────────────────────────────
app.get("/health", (_req, res) =>
  res.json({ status: "ok", ts: new Date().toISOString(), version: "2.0.0" })
);

// ── Public / no-auth routes ───────────────────────────────────
app.use("/metrics",    metricsRouter);
app.use("/portal",     portalRoutes);
app.use("/public/v1",  publicApiLimiter, publicApiRoutes);

// ── Auth ──────────────────────────────────────────────────────
app.use("/api/auth",   authLimiter, authRoutes);

// ── Core ──────────────────────────────────────────────────────
app.use("/api/workspaces",           workspaceRoutes);
app.use("/api/workspaces",           restoreRoutes);
app.use("/api/agents",               agentRoutes);
app.use("/api/channels",             channelRoutes);
app.use("/api/tools",                toolRoutes);
app.use("/api/secrets",              secretRoutes);
app.use("/api/security",             securityRoutes);
app.use("/api/logs",                 logRoutes);
app.use("/api/usage",                usageRoutes);

// ── Phase 2 ───────────────────────────────────────────────────
app.use("/api/review",               reviewRoutes);
app.use("/api/review",               reviewCommentRoutes);
app.use("/api/gateway",              gatewayRoutes);
app.use("/api/templates",            templateRoutes);
app.use("/api/alerts",               alertRoutes);
app.use("/api/sessions",             sessionRoutes);

// ── Phase 3 ───────────────────────────────────────────────────
app.use("/api/whitelabel",           whitelabelRoutes);
app.use("/api/admin",                permissionRoutes);
app.use("/api/admin/api-keys",       apiKeyRoutes);
app.use("/api/admin/webhooks",       webhookAdminRoutes);
app.use("/api/billing",              billingRoutes);
app.use("/api/analytics",            analyticsRoutes);

// ── Integrations ──────────────────────────────────────────────
app.use("/api/oauth/google",         googleOAuthRoutes);
app.use("/api/integrations/sheets",  sheetsRoutes);
app.use("/api/integrations/notion",  notionRoutes);
app.use("/api/integrations/gmail",   gmailRoutes);
app.use("/api/integrations/gcal",    gcalRoutes);

// ── v1.2+ ─────────────────────────────────────────────────────
app.use("/api/quotas",               quotaRouter);
app.use("/api/audit",                auditRoutes);
app.use("/api/playground",           playgroundRoutes);
app.use("/api/flags",                featureFlagRoutes);
app.use("/api/security-tools",       securityToolsRoutes);

// ── v1.3+ ─────────────────────────────────────────────────────
app.use("/api/prompt-versions",      promptVersionRoutes);
app.use("/api/sla",                  slaRoutes);
app.use("/api/bulk",                 bulkRoutes);

// ── v1.4+ ─────────────────────────────────────────────────────
app.use("/api/models",               modelsRoutes);
app.use("/api/export",               exportRoutes);
app.use("/api/tool-builder",         toolBuilderRoutes);

// ── v1.5+ ─────────────────────────────────────────────────────
app.use("/api/knowledge",            knowledgeRoutes);
app.use("/api/ab-tests",             abTestRoutes);

// ── v1.6+ ─────────────────────────────────────────────────────
app.use("/api/flows",                flowRoutes);
app.use("/api/broadcasts",           broadcastRoutes);
app.use("/api/segments",             segmentRoutes);
app.use("/api/handoff",              handoffRoutes);

// ── v1.7+ ─────────────────────────────────────────────────────
app.use("/api/satisfaction",         satisfactionRoutes);
app.use("/api/forms",                formRoutes);
app.use("/api/log-search",           logSearchRoutes);
app.use("/api/media",                mediaRoutes);

// ── v1.8+ ─────────────────────────────────────────────────────
app.use("/api/chains",               chainRoutes);
app.use("/api/super",                superAdminRoutes);

// ── Misc ──────────────────────────────────────────────────────
app.use("/api/orchestration",        orchestrationRoutes);
app.use("/api/notifications",        notificationRoutes);
app.use("/api/marketplace",          marketplaceRoutes);
app.use("/api/security-scan",        securityScanRoutes);

// ── Webhooks ──────────────────────────────────────────────────
app.use("/webhook", webhookLimiter);
app.use("/webhook/line",      lineWebhook);
app.use("/webhook/telegram",  tgWebhook);
app.use("/webhook/slack",     slackWebhook);
app.use("/webhook/discord",   discordWebhook);
app.use("/webhook/whatsapp",  whatsappWebhook);
app.use("/webhook/twilio",    twilioWebhook);

// ── Error handler ─────────────────────────────────────────────
app.use(errorHandler);

// ── Start ─────────────────────────────────────────────────────
async function start() {
  await initRedis();

  server.listen(PORT, () => {
    console.log(`\n✓ MyWrapper Backend v2.0  http://localhost:${PORT}\n`);
    attachWebSocket(server);
    startScheduler();
    setupGracefulShutdown(server, async () => {
      const { prisma } = await import("@/db/client");
      await prisma.$disconnect();
    });
  });
}

start().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});

export { server };
