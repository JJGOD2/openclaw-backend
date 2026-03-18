// src/lib/line.ts
// LINE Messaging API webhook 簽名驗證 + 訊息型別定義
import crypto from "crypto";

// ── Signature verification ────────────────────────────────────
export function verifyLineSignature(
  channelSecret: string,
  rawBody:       string,
  signature:     string
): boolean {
  const hmac = crypto
    .createHmac("sha256", channelSecret)
    .update(rawBody)
    .digest("base64");
  return hmac === signature;
}

// ── LINE event types ─────────────────────────────────────────
export type LineEventType =
  | "message" | "follow" | "unfollow"
  | "join" | "leave" | "postback" | "memberJoined";

export interface LineSource {
  type:    "user" | "group" | "room";
  userId?: string;
  groupId?:string;
  roomId?: string;
}

export interface LineMessageEvent {
  type:      "message";
  timestamp:  number;
  source:     LineSource;
  replyToken: string;
  message: {
    id:   string;
    type: "text" | "image" | "sticker" | "location" | "file";
    text?: string;
  };
}

export interface LineFollowEvent {
  type:       "follow";
  timestamp:  number;
  source:     LineSource;
  replyToken: string;
}

export interface LineWebhookBody {
  destination: string;
  events:      (LineMessageEvent | LineFollowEvent | { type: string })[];
}

// ── LINE Reply API ────────────────────────────────────────────
export async function lineReply(
  channelAccessToken: string,
  replyToken:         string,
  messages:           { type: string; text?: string }[]
): Promise<void> {
  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${channelAccessToken}`,
    },
    body: JSON.stringify({ replyToken, messages }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`LINE reply failed: ${err}`);
  }
}

// ── LINE Push API ─────────────────────────────────────────────
export async function linePush(
  channelAccessToken: string,
  to:                 string,
  messages:           { type: string; text?: string }[]
): Promise<void> {
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${channelAccessToken}`,
    },
    body: JSON.stringify({ to, messages }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`LINE push failed: ${err}`);
  }
}
