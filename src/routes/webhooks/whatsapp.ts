// src/routes/webhooks/whatsapp.ts
// WhatsApp Business Cloud API Webhook
// URL: POST /webhook/whatsapp/:workspaceId/:channelBindingId
// Verify: GET /webhook/whatsapp/:workspaceId/:channelBindingId
import { Router } from "express";
import crypto from "crypto";
import { prisma } from "@/db/client";
import { decryptSecret } from "@/lib/crypto";
import { invokeAgent } from "@/services/agent.service";

const router = Router();

// ── Signature verification ────────────────────────────────────
function verifyWhatsAppSignature(
  appSecret: string,
  rawBody:   string,
  signature: string
): boolean {
  const expected = crypto
    .createHmac("sha256", appSecret)
    .update(rawBody)
    .digest("hex");
  return `sha256=${expected}` === signature;
}

// ── Send WhatsApp message ─────────────────────────────────────
async function whatsappSend(
  accessToken: string,
  phoneNumberId: string,
  to:           string,
  text:         string
): Promise<void> {
  await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type:    "individual",
      to,
      type:              "text",
      text:              { preview_url: false, body: text.slice(0, 4096) },
    }),
  });
}

// ── GET: Webhook Verification (Meta requirement) ──────────────
router.get("/:workspaceId/:channelBindingId", async (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  // Load verify token from secrets
  const { workspaceId } = req.params;
  const verifyTokenRow  = await prisma.secret.findUnique({
    where: { workspaceId_name: { workspaceId, name: "WHATSAPP_VERIFY_TOKEN" } },
  }).catch(() => null);

  const verifyToken = verifyTokenRow?.encryptedValue.startsWith("PLACEHOLDER")
    ? (process.env.WHATSAPP_VERIFY_TOKEN ?? "openclaw-verify")
    : verifyTokenRow ? decryptSecret(verifyTokenRow.encryptedValue) : "openclaw-verify";

  if (mode === "subscribe" && token === verifyToken) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ── POST: Receive Messages ────────────────────────────────────
router.post("/:workspaceId/:channelBindingId", async (req, res) => {
  res.sendStatus(200);

  const rawBody = JSON.stringify(req.body);
  const { workspaceId, channelBindingId } = req.params;

  try {
    const binding = await prisma.channelBinding.findUnique({ where: { id: channelBindingId } });
    if (!binding || binding.workspaceId !== workspaceId) return;

    // Load WhatsApp credentials
    const [appSecretRow, accessTokenRow, phoneIdRow] = await Promise.all([
      prisma.secret.findUnique({ where: { workspaceId_name: { workspaceId, name: "WHATSAPP_APP_SECRET" } } }),
      prisma.secret.findUnique({ where: { workspaceId_name: { workspaceId, name: "WHATSAPP_ACCESS_TOKEN" } } }),
      prisma.secret.findUnique({ where: { workspaceId_name: { workspaceId, name: "WHATSAPP_PHONE_NUMBER_ID" } } }),
    ]);

    const appSecret = appSecretRow?.encryptedValue.startsWith("PLACEHOLDER")
      ? (process.env.WHATSAPP_APP_SECRET ?? "")
      : appSecretRow ? decryptSecret(appSecretRow.encryptedValue) : "";

    const accessToken = accessTokenRow?.encryptedValue.startsWith("PLACEHOLDER")
      ? (process.env.WHATSAPP_ACCESS_TOKEN ?? "")
      : accessTokenRow ? decryptSecret(accessTokenRow.encryptedValue) : "";

    const phoneNumberId = phoneIdRow?.encryptedValue.startsWith("PLACEHOLDER")
      ? (process.env.WHATSAPP_PHONE_NUMBER_ID ?? "")
      : phoneIdRow ? decryptSecret(phoneIdRow.encryptedValue) : "";

    // Verify signature
    const signature = req.headers["x-hub-signature-256"] as string ?? "";
    if (appSecret && !verifyWhatsAppSignature(appSecret, rawBody, signature)) {
      await prisma.logEntry.create({
        data: { workspaceId, type: "WARN", message: "[WhatsApp] 簽名驗證失敗" },
      });
      return;
    }

    // Parse messages
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const msgObj  = changes?.value?.messages?.[0];

    if (!msgObj || msgObj.type !== "text") return;

    const senderId = msgObj.from;
    const text     = msgObj.text?.body ?? "";
    if (!text || !binding.defaultAgentId) return;

    // Allowlist check
    if (binding.allowlistMode) {
      const allowed = await prisma.senderAllowlist.findFirst({
        where: { channelBindingId: binding.id, senderId },
      });
      if (!allowed) {
        await prisma.logEntry.create({
          data: {
            workspaceId, type: "WARN",
            message: `[WhatsApp] 非 allowlist sender ${senderId} 嘗試傳訊，已攔截`,
          },
        });
        return;
      }
    }

    const result = await invokeAgent({
      workspaceId, agentId: binding.defaultAgentId,
      userId: senderId, platform: "WHATSAPP", text,
    });

    if (!result.shouldQueue && accessToken && phoneNumberId) {
      await whatsappSend(accessToken, phoneNumberId, senderId, result.reply);
    }

  } catch (err) {
    console.error("[WhatsApp Webhook]", err);
  }
});

export default router;
