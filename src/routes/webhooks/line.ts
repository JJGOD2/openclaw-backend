// src/routes/webhooks/line.ts
// LINE Messaging API Webhook 接收器
// URL pattern: POST /webhook/line/:workspaceId/:channelBindingId
import { Router, Request, Response } from "express";
import { prisma } from "@/db/client";
import { decryptSecret } from "@/lib/crypto";
import {
  verifyLineSignature, lineReply, linePush,
  LineWebhookBody, LineMessageEvent,
} from "@/lib/line";
import { invokeAgent } from "@/services/agent.service";

const router = Router();

router.post("/:workspaceId/:channelBindingId", async (req: Request, res: Response) => {
  // LINE requires 200 OK immediately
  res.sendStatus(200);

  const { workspaceId, channelBindingId } = req.params;
  const signature = req.headers["x-line-signature"] as string;
  const rawBody   = JSON.stringify(req.body);           // must be raw string

  try {
    // 1. Load channel binding + workspace secrets
    const binding = await prisma.channelBinding.findUnique({
      where:   { id: channelBindingId },
      include: { channel: true },
    });
    if (!binding || binding.workspaceId !== workspaceId) return;

    // 2. Load LINE Channel Secret for signature verify
    const channelSecretRow = await prisma.secret.findUnique({
      where: { workspaceId_name: { workspaceId, name: "LINE_CHANNEL_SECRET" } },
    });
    const channelAccessRow = await prisma.secret.findUnique({
      where: { workspaceId_name: { workspaceId, name: "LINE_CHANNEL_ACCESS_TOKEN" } },
    });

    const channelSecret = channelSecretRow?.encryptedValue.startsWith("PLACEHOLDER")
      ? process.env.LINE_CHANNEL_SECRET ?? ""
      : channelSecretRow ? decryptSecret(channelSecretRow.encryptedValue) : "";

    const channelAccessToken = channelAccessRow?.encryptedValue.startsWith("PLACEHOLDER")
      ? process.env.LINE_CHANNEL_ACCESS_TOKEN ?? ""
      : channelAccessRow ? decryptSecret(channelAccessRow.encryptedValue) : "";

    // 3. Verify signature
    if (channelSecret && !verifyLineSignature(channelSecret, rawBody, signature)) {
      await prisma.logEntry.create({
        data: {
          workspaceId,
          type:    "WARN",
          message: `[LINE Webhook] 簽名驗證失敗，疑似偽造請求`,
        },
      });
      return;
    }

    // 4. Process events
    const body = req.body as LineWebhookBody;
    for (const event of body.events) {
      if (event.type !== "message") continue;
      const msgEvent = event as LineMessageEvent;
      if (msgEvent.message.type !== "text" || !msgEvent.message.text) continue;

      const senderId = msgEvent.source.userId ?? "unknown";
      const text     = msgEvent.message.text;

      // 5. Check allowlist (if enabled)
      if (binding.allowlistMode) {
        const allowed = await prisma.senderAllowlist.findFirst({
          where: { channelBindingId: binding.id, senderId },
        });
        if (!allowed) {
          await prisma.logEntry.create({
            data: {
              workspaceId,
              type:    "WARN",
              message: `[LINE] 非 allowlist sender ${senderId} 嘗試傳訊，已攔截`,
              metadata: { senderId, text: text.slice(0, 100) },
            },
          });
          continue;
        }
      }

      // 6. Determine agent
      const agentId = binding.defaultAgentId;
      if (!agentId) continue;

      // 7. Invoke agent
      try {
        const result = await invokeAgent({
          workspaceId,
          agentId,
          userId:     senderId,
          platform:   "LINE",
          text,
          replyToken: msgEvent.replyToken,
        });

        // 8a. If review not needed → reply immediately
        if (!result.shouldQueue && channelAccessToken) {
          await lineReply(channelAccessToken, msgEvent.replyToken, [
            { type: "text", text: result.reply },
          ]);
        }
        // 8b. If review needed → queued, operator will push after approval

      } catch (agentErr) {
        // Agent invocation failed → log + fallback reply
        await prisma.logEntry.create({
          data: {
            workspaceId,
            type:    "ERROR",
            message: `[LINE] Agent 呼叫失敗：${(agentErr as Error).message}`,
          },
        });
        if (channelAccessToken) {
          await lineReply(channelAccessToken, msgEvent.replyToken, [
            { type: "text", text: "非常抱歉，目前系統忙碌中，請稍後再試。" },
          ]).catch(() => {});
        }
      }
    }
  } catch (err) {
    console.error("[LINE Webhook]", err);
  }
});

export default router;
