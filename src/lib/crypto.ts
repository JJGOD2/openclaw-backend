// src/lib/crypto.ts
import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const KEY = Buffer.from(process.env.ENCRYPTION_KEY ?? "0".repeat(64), "hex");

export function encryptSecret(plaintext: string): string {
  const iv  = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag   = cipher.getAuthTag();
  // format: iv:authTag:ciphertext (base64)
  return [iv.toString("base64"), authTag.toString("base64"), encrypted.toString("base64")].join(":");
}

export function decryptSecret(ciphertext: string): string {
  const [ivB64, authTagB64, encB64] = ciphertext.split(":");
  const iv      = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(authTagB64, "base64");
  const enc     = Buffer.from(encB64, "base64");
  const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(enc).toString("utf8") + decipher.final("utf8");
}

export function maskSecret(value: string): string {
  if (value.length <= 8) return "••••••••";
  return value.slice(0, 4) + "••••••••" + value.slice(-4);
}
