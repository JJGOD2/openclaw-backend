// src/routes/webhooks/telegram.ts
// Telegram Bot Webhook 接收器
// URL: POST /webhook/telegram/:workspaceId/:channelBindingId
import { Router } from "express";
import { prisma } from "@/db/client";
import { decryptSecret } from "@/lib/crypto";
import { invokeAgent } from "@/services/agent.service";

const router = Router();

interface TgMessage {
  message_id: number;
  from?: { id: number; username?: string; first_name?: string };
  chat: { id: number; type: string };
  text?: string;
}
interface TgUpdate {
  update_id: number;
  message?:  TgMessage;
}

async function tgReply(token: string, chatId: number, text: string) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
  });
}

router.post("/:workspaceId/:channelBindingId", async (req, res) => {
  res.sendStatus(200); // Telegram 要求立即 200

  const { workspaceId, channelBindingId } = req.params;
  const update: TgUpdate = req.body;

  try {
    const msg = update.message;
    if (!msg?.text) return;

    const binding = await prisma.channelBinding.findUnique({
      where: { id: channelBindingId },
    });
    if (!binding || binding.workspaceId !== workspaceId) return;

    const senderId = String(msg.from?.id ?? "unknown");

    // Allowlist check
    if (binding.allowlistMode) {
      const allowed = await prisma.senderAllowlist.findFirst({
        where: { channelBindingId: binding.id, senderId },
      });
      if (!allowed) {
        await prisma.logEntry.create({
          data: {
            workspaceId, type: "WARN",
            message: `[Telegram] 非 allowlist sender ${senderId} 嘗試傳訊，已攔截`,
          },
        });
        return;
      }
    }

    // DM scope check for private chats
    if (msg.chat.type === "private" && binding.dmScope === "restricted") {
      const allowed = await prisma.senderAllowlist.findFirst({
        where: { channelBindingId: binding.id, senderId },
      });
      if (!allowed) return;
    }

    if (!binding.defaultAgentId) return;

    // Load bot token
    const tokenRow = await prisma.secret.findUnique({
      where: { workspaceId_name: { workspaceId, name: "TELEGRAM_BOT_TOKEN" } },
    });
    const botToken = tokenRow?.encryptedValue.startsWith("PLACEHOLDER")
      ? process.env.TELEGRAM_BOT_TOKEN ?? ""
      : tokenRow ? decryptSecret(tokenRow.encryptedValue) : "";

    const result = await invokeAgent({
      workspaceId,
      agentId:  binding.defaultAgentId,
      userId:   senderId,
      platform: "TELEGRAM",
      text:     msg.text,
    });

    if (!result.shouldQueue && botToken) {
      await tgReply(botToken, msg.chat.id, result.reply);
    }

  } catch (err) {
    console.error("[Telegram Webhook]", err);
  }
});

// Register webhook with Telegram
export async function registerTelegramWebhook(
  botToken:   string,
  webhookUrl: string
): Promise<{ ok: boolean; description: string }> {
  const res = await fetch(
    `https://api.telegram.org/bot${botToken}/setWebhook`,
    {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ url: webhookUrl, allowed_updates: ["message"] }),
    }
  );
  return res.json();
}

export default router;
