import "dotenv/config";
import { initRedis }            from "@/lib/cache/redis";
import { initTelemetry }          from "@/lib/observability/telemetry";
import { featureFlagMiddleware }   from "@/lib/flags/feature-flags";
import metricsRouter               from "@/routes/metrics";
import featureFlagRoutes           from "@/routes/feature-flags";
import { validateEnv, setupGracefulShutdown } from "@/lib/startup";
import { requestId } from "@/middleware/requestId";

// Validate environment variables before anything else
validateEnv();
initTelemetry();
await initRedis();
import http from "http";
import express from "express";
import securityToolsRoutes from "@/routes/security-tools";
import chainRoutes      from "@/routes/chains";
import superAdminRoutes from "@/routes/super-admin";
import twilioWebhook    from "@/routes/webhooks/twilio";
import mediaRoutes        from "@/routes/media";
import satisfactionRoutes  from "@/routes/satisfaction";
import formRoutes          from "@/routes/forms";
import logSearchRoutes     from "@/routes/log-search";
import flowRoutes       from "@/routes/flows";
import broadcastRoutes   from "@/routes/broadcast";
import segmentRoutes     from "@/routes/segments";
import handoffRoutes     from "@/routes/handoff";
import orchestrationRoutes from "@/routes/orchestration";
import notificationRoutes  from "@/routes/notifications";
import marketplaceRoutes   from "@/routes/marketplace";
import securityScanRoutes  from "@/routes/security-scan";
import knowledgeRoutes  from "@/routes/knowledge";
import abTestRoutes     from "@/routes/ab-test";
import modelsRoutes        from "@/routes/models";
import exportRoutes        from "@/routes/export";
import reviewCommentRoutes from "@/routes/review-comments";
import toolBuilderRoutes   from "@/routes/tool-builder";
import promptVersionRoutes from "@/routes/prompt-versions";
import slaRoutes           from "@/routes/sla";
import bulkRoutes          from "@/routes/bulk";
import { quotaRouter }  from "@/lib/quotas";
import auditRoutes     from "@/routes/audit";
import playgroundRoutes from "@/routes/playground";
import portalRoutes    from "@/routes/portal";
import billingRoutes    from "@/routes/billing";
import analyticsRoutes  from "@/routes/analytics";
import whatsappWebhook  from "@/routes/webhooks/whatsapp";
import { apiLimiter, authLimiter, webhookLimiter, publicApiLimiter } from "@/middleware/rateLimit";
import { errorHandler }   from "@/middleware/errorHandler";
import { attachWebSocket } from "@/lib/websocket";
import { startScheduler }  from "@/jobs/scheduler";

// Phase 1
import authRoutes      from "@/routes/auth";
import workspaceRoutes from "@/routes/workspaces";
import agentRoutes     from "@/routes/agents";
import channelRoutes   from "@/routes/channels";
import toolRoutes      from "@/routes/tools";
import secretRoutes    from "@/routes/secrets";
import securityRoutes  from "@/routes/security";
import logRoutes       from "@/routes/logs";
import usageRoutes     from "@/routes/usage";
// Phase 2
import reviewRoutes    from "@/routes/review";
import gatewayRoutes   from "@/routes/gateway";
import templateRoutes  from "@/routes/templates";
import alertRoutes     from "@/routes/alerts";
import lineWebhook     from "@/routes/webhooks/line";
import tgWebhook       from "@/routes/webhooks/telegram";
// Phase 3
import whitelabelRoutes   from "@/routes/whitelabel";
import permissionRoutes   from "@/routes/admin/permissions";
import apiKeyRoutes       from "@/routes/admin/api-keys";
import webhookAdminRoutes from "@/routes/admin/webhooks";
import publicApiRoutes    from "@/routes/public-api";
import restoreRoutes  from "@/routes/workspaces.restore";
import slackWebhook  from "@/routes/webhooks/slack";
import discordWebhook from "@/routes/webhooks/discord";
import sessionRoutes from "@/routes/sessions";
import googleOAuthRoutes from "@/routes/integrations/oauth/google";
import sheetsRoutes       from "@/routes/integrations/sheets";
import notionRoutes  from "@/routes/integrations/notion";
import gmailRoutes   from "@/routes/integrations/gmail";
import gcalRoutes    from "@/routes/integrations/gcal";

const app    = express();
const server = http.createServer(app);
const PORT   = Number(process.env.PORT ?? 4000);

// Raw body for webhook signature
app.use(["/webhook/line","/webhook/telegram","/webhook/slack","/webhook/discord","/webhook/whatsapp","/api/billing/webhook","/portal"],
  express.raw({ type:"application/json" }),
  (req: express.Request,_res: express.Response,next: express.NextFunction) => {
    if (Buffer.isBuffer(req.body)) req.body = JSON.parse(req.body.toString("utf-8"));
    next();
  }
);

app.use(requestId());
app.use(featureFlagMiddleware());
app.use(express.json({ limit:"2mb" }));
app.use(express.urlencoded({ extended:true }));
app.use((req,res,next) => {
  const origin = process.env.CORS_ORIGIN ?? "http://localhost:3000";
  res.setHeader("Access-Control-Allow-Origin",  origin);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,X-Api-Key");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Global rate limiter
app.use("/api", apiLimiter);

// Routes
app.use("/api/auth",       authLimiter, authRoutes);
app.use("/api/workspaces", workspaceRoutes);
app.use("/api/agents",     agentRoutes);
app.use("/api/channels",   channelRoutes);
app.use("/api/tools",      toolRoutes);
app.use("/api/secrets",    secretRoutes);
app.use("/metrics",       metricsRouter);
app.use("/api/flags",     featureFlagRoutes);
app.use("/api/security",   securityRoutes);
app.use("/api/logs",       logRoutes);
app.use("/api/usage",      usageRoutes);
app.use("/api/review",     reviewRoutes);
app.use("/api/gateway",    gatewayRoutes);
app.use("/api/templates",  templateRoutes);
app.use("/api/alerts",     alertRoutes);
app.use("/webhook/line",   lineWebhook);
app.use("/webhook", webhookLimiter);
app.use("/webhook/whatsapp",  whatsappWebhook);
app.use("/webhook/slack",    slackWebhook);
app.use("/webhook/discord",  discordWebhook);
app.use("/webhook/telegram", tgWebhook);
app.use("/api/whitelabel",          whitelabelRoutes);
app.use("/api/admin",               permissionRoutes);
app.use("/api/admin/api-keys",      apiKeyRoutes);
app.use("/api/admin/webhooks",      webhookAdminRoutes);
app.use("/metrics",       metricsRouter);
app.use("/api/flags",     featureFlagRoutes);
app.use("/api/security",    securityToolsRoutes);
app.use("/api/chains",  chainRoutes);
app.use("/api/super",   superAdminRoutes);
app.use("/webhook/twilio", twilioWebhook);
app.use("/api/media",        mediaRoutes);
app.use("/api/satisfaction", satisfactionRoutes);
app.use("/api/forms",        formRoutes);
app.use("/api/log-search",   logSearchRoutes);
app.use("/api/flows",       flowRoutes);
app.use("/api/broadcasts",  broadcastRoutes);
app.use("/api/segments",    segmentRoutes);
app.use("/api/handoff",     handoffRoutes);
app.use("/api/orchestration",  orchestrationRoutes);
app.use("/api/notifications",  notificationRoutes);
app.use("/api/marketplace",    marketplaceRoutes);
app.use("/api/security-scan",  securityScanRoutes);
app.use("/api/knowledge",    knowledgeRoutes);
app.use("/api/ab-tests",     abTestRoutes);
app.use("/api/models",          modelsRoutes);
app.use("/api/export",          exportRoutes);
app.use("/api/review",          reviewCommentRoutes);
app.use("/api/tool-builder",    toolBuilderRoutes);
app.use("/api/prompt-versions", promptVersionRoutes);
app.use("/api/sla",             slaRoutes);
app.use("/api/bulk",            bulkRoutes);
app.use("/api/quotas",      quotaRouter);
app.use("/api/audit",       auditRoutes);
app.use("/api/playground",  playgroundRoutes);
app.use("/portal",          portalRoutes);
app.use("/api/billing",        billingRoutes);
app.use("/api/analytics",      analyticsRoutes);
app.use("/api/workspaces/:id/backups", restoreRoutes);
app.use("/api/oauth/google", googleOAuthRoutes);
app.use("/api/sessions",             sessionRoutes);
app.use("/api/integrations/sheets", sheetsRoutes);
app.use("/public/v1",               publicApiLimiter, publicApiRoutes);

app.get("/health",(_req,res)=>res.json({status:"ok",ts:new Date().toISOString(),version:"1.0.0"}));
app.use(errorHandler);

server.listen(PORT, () => {
  setupGracefulShutdown(server, async () => {
    const { prisma } = await import("@/db/client");
    await prisma.$disconnect();
  });
  console.log(`\n🚀 OpenClaw Backend v1.0.0  http://localhost:${PORT}\n`);
  attachWebSocket(server);
  startScheduler();
});

export { server };