// src/routes/webhooks/twilio.ts
// Twilio SMS + Voice Webhook 接收器
// SMS URL:   POST /webhook/twilio/sms/:workspaceId/:channelBindingId
// Voice URL: POST /webhook/twilio/voice/:workspaceId/:channelBindingId
import { Router } from "express";
import crypto from "crypto";
import { prisma } from "@/db/client";
import { decryptSecret } from "@/lib/crypto";
import { invokeAgent } from "@/services/agent.service";

const router = Router();

// ── Twilio signature verification ─────────────────────────────
function verifyTwilioSignature(
  authToken:   string,
  url:         string,
  params:      Record<string, string>,
  signature:   string
): boolean {
  // Sort params and append to URL
  const sortedParams = Object.keys(params).sort()
    .reduce((str, key) => str + key + params[key], url);
  const hmac = crypto
    .createHmac("sha1", authToken)
    .update(sortedParams)
    .digest("base64");
  return hmac === signature;
}

// ── TwiML response builder ────────────────────────────────────
function twimlSay(text: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say language="zh-TW" voice="Google.zh-TW-Standard-A">${text}</Say></Response>`;
}
function twimlSms(text: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${text}</Message></Response>`;
}

// ── Load Twilio credentials ───────────────────────────────────
async function loadTwilioCreds(workspaceId: string) {
  const [sidRow, tokenRow] = await Promise.all([
    prisma.secret.findUnique({ where: { workspaceId_name: { workspaceId, name: "TWILIO_ACCOUNT_SID" } } }),
    prisma.secret.findUnique({ where: { workspaceId_name: { workspaceId, name: "TWILIO_AUTH_TOKEN" } } }),
  ]);
  const authToken = tokenRow?.encryptedValue.startsWith("PLACEHOLDER")
    ? (process.env.TWILIO_AUTH_TOKEN ?? "")
    : tokenRow ? decryptSecret(tokenRow.encryptedValue) : "";
  return authToken;
}

// ── SMS handler ───────────────────────────────────────────────
router.post("/sms/:workspaceId/:channelBindingId", async (req, res) => {
  const { workspaceId, channelBindingId } = req.params;
  res.setHeader("Content-Type", "text/xml");

  try {
    const binding = await prisma.channelBinding.findUnique({ where: { id: channelBindingId } });
    if (!binding || binding.workspaceId !== workspaceId) {
      return res.send(twimlSms("Sorry, this number is not configured."));
    }

    // Verify Twilio signature
    const authToken = await loadTwilioCreds(workspaceId);
    if (authToken) {
      const backendUrl = process.env.BACKEND_URL ?? "http://localhost:4000";
      const url        = `${backendUrl}/webhook/twilio/sms/${workspaceId}/${channelBindingId}`;
      const sig        = req.headers["x-twilio-signature"] as string ?? "";
      if (!verifyTwilioSignature(authToken, url, req.body as Record<string,string>, sig)) {
        return res.status(403).send(twimlSms("Unauthorized"));
      }
    }

    const from = String(req.body.From ?? "");
    const body = String(req.body.Body ?? "");
    if (!body.trim() || !binding.defaultAgentId) {
      return res.send(twimlSms(""));
    }

    // Allowlist check
    if (binding.allowlistMode) {
      const allowed = await prisma.senderAllowlist.findFirst({
        where: { channelBindingId: binding.id, senderId: from },
      });
      if (!allowed) return res.send(twimlSms(""));
    }

    const result = await invokeAgent({
      workspaceId,
      agentId:  binding.defaultAgentId,
      userId:   from,
      platform: "SMS",
      text:     body,
    });

    const reply = result.shouldQueue
      ? "您的請求正在處理中，稍後會有專人回覆。"
      : result.reply.slice(0, 1600);   // SMS character limit

    res.send(twimlSms(reply));
  } catch (err) {
    console.error("[Twilio SMS]", err);
    res.send(twimlSms("系統忙碌中，請稍後再試。"));
  }
});

// ── Voice handler ─────────────────────────────────────────────
router.post("/voice/:workspaceId/:channelBindingId", async (req, res) => {
  const { workspaceId, channelBindingId } = req.params;
  res.setHeader("Content-Type", "text/xml");

  try {
    const binding = await prisma.channelBinding.findUnique({ where: { id: channelBindingId } });
    if (!binding || binding.workspaceId !== workspaceId || !binding.defaultAgentId) {
      return res.send(twimlSay("很抱歉，此號碼目前無法服務，請稍後再撥。"));
    }

    // Get speech input via <Gather>
    const speechResult = req.body.SpeechResult ?? "";
    const callSid      = String(req.body.CallSid ?? "");

    if (!speechResult) {
      // First call — prompt user to speak
      const backendUrl = process.env.BACKEND_URL ?? "http://localhost:4000";
      const actionUrl  = `${backendUrl}/webhook/twilio/voice/${workspaceId}/${channelBindingId}`;
      return res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" language="zh-TW" speechTimeout="auto" action="${actionUrl}" method="POST">
    <Say language="zh-TW">您好，我是 AI 助理，請說話，我正在聆聽。</Say>
  </Gather>
  <Say language="zh-TW">抱歉，我沒有聽到您說話，請再試一次。</Say>
</Response>`);
    }

    // Process speech with agent
    const result = await invokeAgent({
      workspaceId,
      agentId:  binding.defaultAgentId,
      userId:   callSid,
      platform: "VOICE",
      text:     speechResult,
    });

    const reply = result.shouldQueue
      ? "您的請求正在處理，稍後會有專人與您聯繫，感謝您的來電。"
      : result.reply;

    // Continue conversation with another gather
    const backendUrl = process.env.BACKEND_URL ?? "http://localhost:4000";
    const actionUrl  = `${backendUrl}/webhook/twilio/voice/${workspaceId}/${channelBindingId}`;
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="zh-TW">${reply}</Say>
  <Gather input="speech" language="zh-TW" speechTimeout="auto" action="${actionUrl}" method="POST">
    <Say language="zh-TW">您還有其他問題嗎？</Say>
  </Gather>
  <Say language="zh-TW">感謝您的來電，再見。</Say>
  <Hangup/>
</Response>`);
  } catch (err) {
    console.error("[Twilio Voice]", err);
    res.send(twimlSay("很抱歉，系統發生錯誤，請稍後再撥。"));
  }
});

export default router;
