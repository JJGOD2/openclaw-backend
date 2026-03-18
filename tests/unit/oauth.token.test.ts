// tests/unit/oauth.token.test.ts
import { describe, it, expect, jest, beforeEach } from "@jest/globals";

jest.mock("@/db/client", () => ({
  prisma: {
    oAuthToken: {
      findUnique: jest.fn(),
      update:     jest.fn(),
      upsert:     jest.fn(),
      delete:     jest.fn(),
    },
    secret: {
      findUnique: jest.fn(),
    },
    logEntry: {
      create: jest.fn(),
    },
  },
}));

jest.mock("@/lib/crypto", () => ({
  encryptSecret: jest.fn((v: string) => `enc:${v}`),
  decryptSecret: jest.fn((v: string) => v.replace("enc:", "")),
}));

import { prisma } from "@/db/client";
import {
  getValidAccessToken,
  getTokenStatus,
  OAuthNotConfiguredError,
  OAuthExpiredError,
  OAuthInvalidError,
} from "@/services/oauth/token.service";

const mockPrisma = prisma as jest.Mocked<typeof prisma>;

describe("oauth.token.service", () => {
  beforeEach(() => jest.clearAllMocks());

  const validToken = {
    id:                    "tok-1",
    workspaceId:           "ws-test",
    provider:              "GOOGLE" as const,
    scope:                 "https://www.googleapis.com/auth/gmail.modify",
    encryptedAccessToken:  "enc:ya29.valid_token",
    encryptedRefreshToken: "enc:1//refresh_token",
    expiresAt:             new Date(Date.now() + 30 * 60 * 1000),  // 30 mins from now
    isValid:               true,
    refreshFailCount:      0,
  };

  describe("getValidAccessToken", () => {
    it("returns access token when valid and not expiring", async () => {
      (mockPrisma.oAuthToken.findUnique as jest.Mock).mockResolvedValue(validToken);

      const token = await getValidAccessToken("ws-test", "GOOGLE", validToken.scope);

      expect(token).toBe("ya29.valid_token");
      expect(mockPrisma.oAuthToken.update).not.toHaveBeenCalled();
    });

    it("throws OAuthNotConfiguredError when no token exists", async () => {
      (mockPrisma.oAuthToken.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        getValidAccessToken("ws-test", "GOOGLE", validToken.scope)
      ).rejects.toThrow(OAuthNotConfiguredError);
    });

    it("throws OAuthInvalidError when token is marked invalid", async () => {
      (mockPrisma.oAuthToken.findUnique as jest.Mock).mockResolvedValue({
        ...validToken, isValid: false, refreshFailCount: 3,
      });

      await expect(
        getValidAccessToken("ws-test", "GOOGLE", validToken.scope)
      ).rejects.toThrow(OAuthInvalidError);
    });

    it("throws OAuthExpiredError when token expired and no refresh token", async () => {
      (mockPrisma.oAuthToken.findUnique as jest.Mock).mockResolvedValue({
        ...validToken,
        expiresAt:             new Date(Date.now() - 1000),  // expired
        encryptedRefreshToken: null,
      });

      await expect(
        getValidAccessToken("ws-test", "GOOGLE", validToken.scope)
      ).rejects.toThrow(OAuthExpiredError);
    });

    it("still returns access token if refresh fails but token not yet expired", async () => {
      const expiringSoon = {
        ...validToken,
        expiresAt:        new Date(Date.now() + 60 * 1000),  // 1 min, within buffer
        refreshFailCount: 0,
      };
      (mockPrisma.oAuthToken.findUnique as jest.Mock).mockResolvedValue(expiringSoon);
      (mockPrisma.secret.findUnique as jest.Mock).mockResolvedValue(null);  // no client id → refresh will fail
      (mockPrisma.oAuthToken.update as jest.Mock).mockResolvedValue({});
      (mockPrisma.logEntry.create as jest.Mock).mockResolvedValue({});

      // Should not throw, should return old token
      const token = await getValidAccessToken("ws-test", "GOOGLE", validToken.scope);
      expect(token).toBe("ya29.valid_token");
    });
  });

  describe("getTokenStatus", () => {
    it("returns not-exists status when no token", async () => {
      (mockPrisma.oAuthToken.findUnique as jest.Mock).mockResolvedValue(null);

      const status = await getTokenStatus("ws-test", "GOOGLE", validToken.scope);
      expect(status.exists).toBe(false);
      expect(status.isValid).toBe(false);
    });

    it("returns correct expiry info for valid token", async () => {
      const expiresAt = new Date(Date.now() + 45 * 60 * 1000);  // 45 mins
      (mockPrisma.oAuthToken.findUnique as jest.Mock).mockResolvedValue({ ...validToken, expiresAt });

      const status = await getTokenStatus("ws-test", "GOOGLE", validToken.scope);

      expect(status.exists).toBe(true);
      expect(status.isValid).toBe(true);
      expect(status.needsRefresh).toBe(false);
      expect(status.expiresInMinutes).toBeGreaterThan(40);
    });

    it("marks needsRefresh when expiring within buffer", async () => {
      const expiresAt = new Date(Date.now() + 2 * 60 * 1000);  // 2 mins, within 5-min buffer
      (mockPrisma.oAuthToken.findUnique as jest.Mock).mockResolvedValue({ ...validToken, expiresAt });

      const status = await getTokenStatus("ws-test", "GOOGLE", validToken.scope);
      expect(status.needsRefresh).toBe(true);
    });
  });
});
