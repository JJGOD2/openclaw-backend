// tests/unit/crypto.test.ts
import { describe, it, expect } from "@jest/globals";

// Set up ENCRYPTION_KEY for tests
process.env.ENCRYPTION_KEY = "0".repeat(64);

import { encryptSecret, decryptSecret, maskSecret } from "@/lib/crypto";

describe("crypto utilities", () => {
  describe("encryptSecret / decryptSecret", () => {
    it("round-trips a simple string", () => {
      const original = "sk-ant-supersecret123";
      const encrypted = encryptSecret(original);
      expect(decryptSecret(encrypted)).toBe(original);
    });

    it("produces different ciphertexts for the same plaintext (random IV)", () => {
      const plain = "same-secret";
      expect(encryptSecret(plain)).not.toBe(encryptSecret(plain));
    });

    it("format is iv:authTag:ciphertext (3 parts split by :)", () => {
      const enc = encryptSecret("test");
      const parts = enc.split(":");
      expect(parts).toHaveLength(3);
    });

    it("throws on tampered ciphertext", () => {
      const enc    = encryptSecret("test");
      const parts  = enc.split(":");
      parts[2]     = "tampered_ciphertext_here";
      const tampered = parts.join(":");
      expect(() => decryptSecret(tampered)).toThrow();
    });

    it("handles unicode / Chinese content correctly", () => {
      const chinese = "這是一段包含中文的 API 金鑰：abc123";
      expect(decryptSecret(encryptSecret(chinese))).toBe(chinese);
    });
  });

  describe("maskSecret", () => {
    it("masks middle characters for normal key", () => {
      const masked = maskSecret("sk-ant-abcdefghijk");
      expect(masked).toMatch(/^sk-a••••••••hijk$/);
    });

    it("returns full mask for short strings", () => {
      expect(maskSecret("short")).toBe("••••••••");
    });

    it("does not expose more than first 4 and last 4 chars", () => {
      const key    = "sk-ant-supersecretkey";
      const masked = maskSecret(key);
      const exposed = masked.replace(/•/g, "");
      expect(exposed.length).toBeLessThanOrEqual(8);
    });
  });
});
