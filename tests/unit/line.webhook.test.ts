// tests/unit/line.webhook.test.ts
import { describe, it, expect } from "@jest/globals";
import crypto from "crypto";
import { verifyLineSignature } from "@/lib/line";

describe("LINE webhook signature verification", () => {
  const channelSecret = "test_channel_secret_32chars_here";

  function makeSignature(secret: string, body: string): string {
    return crypto.createHmac("sha256", secret).update(body).digest("base64");
  }

  it("returns true for valid signature", () => {
    const body = JSON.stringify({ events: [] });
    const sig  = makeSignature(channelSecret, body);
    expect(verifyLineSignature(channelSecret, body, sig)).toBe(true);
  });

  it("returns false for tampered body", () => {
    const body      = JSON.stringify({ events: [] });
    const tamperedBody = JSON.stringify({ events: [{ type: "message" }] });
    const sig  = makeSignature(channelSecret, body);
    expect(verifyLineSignature(channelSecret, tamperedBody, sig)).toBe(false);
  });

  it("returns false for wrong secret", () => {
    const body = JSON.stringify({ events: [] });
    const sig  = makeSignature("wrong_secret", body);
    expect(verifyLineSignature(channelSecret, body, sig)).toBe(false);
  });

  it("returns false for empty signature", () => {
    const body = JSON.stringify({ events: [] });
    expect(verifyLineSignature(channelSecret, body, "")).toBe(false);
  });
});
