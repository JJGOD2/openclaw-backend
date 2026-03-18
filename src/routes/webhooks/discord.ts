// src/routes/webhooks/discord.ts
// Discord Bot Gateway Webhook (Interactions endpoint)
// URL: POST /webhook/discord/:workspaceId/:channelBindingId
import { Router } from "express";
import crypto from "crypto";
import { prisma } from "@/db/client";
import { decryptSecret } from "@/lib/crypto";
import { invokeAgent } from "@/services/agent.service";

const router = Router();

// ── Discord Ed25519 signature verification ────────────────────
function verifyDiscordSignature(
  publicKey: string,
  timestamp: string,
  rawBody:   string,
  signature: string
): boolean {
  try {
    const msg  = Buffer.from(timestamp + rawBody);
    const sig  = Buffer.from(signature, "hex");
    const key  = Buffer.from(publicKey,  "hex");
    return crypto.verify("ed25519", msg, { key, format: "der", type: "spki",
      // Convert raw 32-byte Ed25519 public key to DER format
      ...(() => {
        const der = Buffer.alloc(44);
        Buffer.from("302a300506032b6570032100", "hex").copy(der);
        key.copy(der, 12);
        return { key: der };
      })()
    }, sig);
  } catch { return false; }
}

// ── Send Discord message via REST API ─────────────────────────
async function discordReply(
  botToken:  string,
  channelId: string,
  content:   string
): Promise<void> {
  await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method:  "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bot ${botToken}` },
    body:    JSON.stringify({ content: content.slice(0, 2000) }),  // Discord 2000 char limit
  });
}

router.post("/:workspaceId/:channelBindingId", async (req, res) => {
  const rawBody  = JSON.stringify(req.body);
  const { workspaceId, channelBindingId } = req.params;

  try {
    const binding = await prisma.channelBinding.findUnique({ where: { id: channelBindingId } });
    if (!binding || binding.workspaceId !== workspaceId) return res.sendStatus(401);

    // Load Discord public key for signature verification
    const pubKeyRow = await prisma.secret.findUnique({
      where: { workspaceId_name: { workspaceId, name: "DISCORD_PUBLIC_KEY" } },
    });
    const publicKey = pubKeyRow?.encryptedValue.startsWith("PLACEHOLDER")
      ? (process.env.DISCORD_PUBLIC_KEY ?? "")
      : pubKeyRow ? decryptSecret(pubKeyRow.encryptedValue) : "";

    if (publicKey) {
      const signature = req.headers["x-signature-ed25519"] as string ?? "";
      const timestamp = req.headers["x-signature-timestamp"] as string ?? "";
      if (!verifyDiscordSignature(publicKey, timestamp, rawBody, signature)) {
        return res.status(401).json({ error: "Invalid signature" });
      }
    }

    const body = req.body;

    // Discord PING (required during bot setup)
    if (body.type === 1) {
      return res.json({ type: 1 });
    }

    // APPLICATION_COMMAND (slash command) or MESSAGE_CREATE via webhook
    if (body.type === 2 || body.type === 3) {
      // Acknowledge immediately
      res.json({ type: 5 });   // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE

      const content  = body.data?.options?.[0]?.value ?? body.content ?? "";
      const senderId = body.member?.user?.id ?? body.user?.id ?? "unknown";
      const channelId= body.channel_id ?? body.channel?.id;

      if (!content || !binding.defaultAgentId || !channelId) return;

      const botTokenRow = await prisma.secret.findUnique({
        where: { workspaceId_name: { workspaceId, name: "DISCORD_BOT_TOKEN" } },
      });
      const botToken = botTokenRow?.encryptedValue.startsWith("PLACEHOLDER")
        ? (process.env.DISCORD_BOT_TOKEN ?? "")
        : botTokenRow ? decryptSecret(botTokenRow.encryptedValue) : "";

      const result = await invokeAgent({
        workspaceId, agentId: binding.defaultAgentId,
        userId: senderId, platform: "DISCORD", text: content,
      });

      if (!result.shouldQueue && botToken) {
        await discordReply(botToken, channelId, result.reply);
      }
      return;
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("[Discord Webhook]", err);
    res.sendStatus(500);
  }
});

export default router;
