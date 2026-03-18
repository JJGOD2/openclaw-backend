// src/routes/webhooks/slack.ts
// Slack Events API Webhook
// URL: POST /webhook/slack/:workspaceId/:channelBindingId
import { Router } from "express";
import crypto from "crypto";
import { prisma } from "@/db/client";
import { decryptSecret } from "@/lib/crypto";
import { invokeAgent } from "@/services/agent.service";

const router = Router();

// ── Slack signature verification ──────────────────────────────
function verifySlackSignature(
  signingSecret: string,
  timestamp:     string,
  rawBody:       string,
  signature:     string
): boolean {
  // Reject if timestamp is older than 5 minutes
  const ts = parseInt(timestamp, 10);
  if (Math.abs(Date.now() / 1000 - ts) > 300) return false;

  const baseString = `v0:${timestamp}:${rawBody}`;
  const hmac       = crypto
    .createHmac("sha256", signingSecret)
    .update(baseString)
    .digest("hex");

  return crypto.timingSafeEqual(
    Buffer.from(`v0=${hmac}`),
    Buffer.from(signature)
  );
}

// ── Send Slack message via Web API ────────────────────────────
async function slackReply(
  botToken: string,
  channel:  string,
  text:     string,
  threadTs?: string
): Promise<void> {
  await fetch("https://slack.com/api/chat.postMessage", {
    method:  "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${botToken}` },
    body:    JSON.stringify({ channel, text, ...(threadTs ? { thread_ts: threadTs } : {}) }),
  });
}

router.post("/:workspaceId/:channelBindingId", async (req, res) => {
  const rawBody  = JSON.stringify(req.body);
  const { workspaceId, channelBindingId } = req.params;

  // ── URL Verification challenge ─────────────────────────────
  if (req.body?.type === "url_verification") {
    return res.json({ challenge: req.body.challenge });
  }

  // Slack requires 200 OK quickly
  res.sendStatus(200);

  try {
    const binding = await prisma.channelBinding.findUnique({ where: { id: channelBindingId } });
    if (!binding || binding.workspaceId !== workspaceId) return;

    // Load Slack signing secret
    const signingSecretRow = await prisma.secret.findUnique({
      where: { workspaceId_name: { workspaceId, name: "SLACK_SIGNING_SECRET" } },
    });
    const signingSecret = signingSecretRow?.encryptedValue.startsWith("PLACEHOLDER")
      ? (process.env.SLACK_SIGNING_SECRET ?? "")
      : signingSecretRow ? decryptSecret(signingSecretRow.encryptedValue) : "";

    // Verify signature
    if (signingSecret) {
      const ts  = req.headers["x-slack-request-timestamp"] as string ?? "";
      const sig = req.headers["x-slack-signature"] as string ?? "";
      if (!verifySlackSignature(signingSecret, ts, rawBody, sig)) {
        await prisma.logEntry.create({
          data: { workspaceId, type: "WARN", message: "[Slack] 簽名驗證失敗" },
        });
        return;
      }
    }

    const event = req.body?.event;
    // Only handle message events, ignore bot messages
    if (!event || event.type !== "message" || event.bot_id || event.subtype) return;

    const senderId = event.user;
    const text     = event.text ?? "";
    const channel  = event.channel;
    const threadTs = event.thread_ts ?? event.ts;

    // Allowlist check
    if (binding.allowlistMode) {
      const allowed = await prisma.senderAllowlist.findFirst({
        where: { channelBindingId: binding.id, senderId },
      });
      if (!allowed) {
        await prisma.logEntry.create({
          data: { workspaceId, type: "WARN",
            message: `[Slack] 非 allowlist sender ${senderId} 嘗試傳訊，已攔截` },
        });
        return;
      }
    }

    if (!binding.defaultAgentId) return;

    // Load bot token
    const botTokenRow = await prisma.secret.findUnique({
      where: { workspaceId_name: { workspaceId, name: "SLACK_BOT_TOKEN" } },
    });
    const botToken = botTokenRow?.encryptedValue.startsWith("PLACEHOLDER")
      ? (process.env.SLACK_BOT_TOKEN ?? "")
      : botTokenRow ? decryptSecret(botTokenRow.encryptedValue) : "";

    const result = await invokeAgent({
      workspaceId, agentId: binding.defaultAgentId,
      userId: senderId, platform: "SLACK", text,
    });

    if (!result.shouldQueue && botToken) {
      await slackReply(botToken, channel, result.reply, threadTs);
    }

  } catch (err) {
    console.error("[Slack Webhook]", err);
  }
});

export default router;
