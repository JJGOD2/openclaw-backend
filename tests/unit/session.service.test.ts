// tests/unit/session.service.test.ts
import { describe, it, expect, jest, beforeEach } from "@jest/globals";

// Mock prisma
jest.mock("@/db/client", () => ({
  prisma: {
    conversationSession: {
      findUnique:  jest.fn(),
      upsert:      jest.fn(),
      update:      jest.fn(),
      updateMany:  jest.fn(),
      count:       jest.fn(),
    },
    conversationMessage: {
      findMany:    jest.fn(),
      createMany:  jest.fn(),
      deleteMany:  jest.fn(),
      count:       jest.fn(),
    },
  },
}));

import { prisma } from "@/db/client";
import { getOrCreateSession, appendMessages } from "@/services/session.service";

const mockPrisma = prisma as jest.Mocked<typeof prisma>;

describe("session.service", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("getOrCreateSession", () => {
    const params = {
      workspaceId: "ws-test",
      agentId:     "agent-test",
      platform:    "LINE",
      userId:      "user-001",
    };

    it("returns existing active session with history", async () => {
      const mockSession = {
        id:           "session-1",
        isActive:     true,
        lastActiveAt: new Date(),   // just now → not idle
        messages: [
          { role: "USER",      content: "Hello" },
          { role: "ASSISTANT", content: "Hi there!" },
        ],
      };
      (mockPrisma.conversationSession.findUnique as jest.Mock).mockResolvedValue(mockSession);

      const result = await getOrCreateSession(params);

      expect(result.sessionId).toBe("session-1");
      expect(result.isNew).toBe(false);
      expect(result.history).toHaveLength(2);
      expect(result.history[0]).toEqual({ role: "user", content: "Hello" });
      expect(result.history[1]).toEqual({ role: "assistant", content: "Hi there!" });
    });

    it("creates new session when none exists", async () => {
      (mockPrisma.conversationSession.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.conversationSession.upsert as jest.Mock).mockResolvedValue({ id: "session-new" });

      const result = await getOrCreateSession(params);

      expect(result.sessionId).toBe("session-new");
      expect(result.isNew).toBe(true);
      expect(result.history).toHaveLength(0);
    });

    it("creates new session when existing session is idle", async () => {
      const idleTime = new Date(Date.now() - 40 * 60 * 1000);   // 40 mins ago
      const mockSession = {
        id:           "session-old",
        isActive:     true,
        lastActiveAt: idleTime,
        messages:     [],
      };
      (mockPrisma.conversationSession.findUnique as jest.Mock).mockResolvedValue(mockSession);
      (mockPrisma.conversationSession.update as jest.Mock).mockResolvedValue({});
      (mockPrisma.conversationSession.upsert as jest.Mock).mockResolvedValue({ id: "session-new" });

      const result = await getOrCreateSession(params);

      // Should have marked old session inactive
      expect(mockPrisma.conversationSession.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { isActive: false } })
      );
      expect(result.isNew).toBe(true);
    });

    it("filters out SYSTEM messages from history", async () => {
      const mockSession = {
        id:           "session-1",
        isActive:     true,
        lastActiveAt: new Date(),
        messages: [
          { role: "SYSTEM",    content: "[對話摘要] 用戶詢問訂單..." },
          { role: "USER",      content: "訂單到了嗎？" },
          { role: "ASSISTANT", content: "正在查詢中..." },
        ],
      };
      (mockPrisma.conversationSession.findUnique as jest.Mock).mockResolvedValue(mockSession);

      const result = await getOrCreateSession(params);

      // SYSTEM message should be filtered out
      expect(result.history).toHaveLength(2);
      expect(result.history.every(m => m.role !== "system")).toBe(true);
    });

    it("truncates long messages in history", async () => {
      const longContent = "A".repeat(3000);   // exceeds MAX_MESSAGE_CHARS
      const mockSession = {
        id:           "session-1",
        isActive:     true,
        lastActiveAt: new Date(),
        messages:     [{ role: "USER", content: longContent }],
      };
      (mockPrisma.conversationSession.findUnique as jest.Mock).mockResolvedValue(mockSession);

      const result = await getOrCreateSession(params);

      expect(result.history[0].content.length).toBeLessThan(longContent.length);
      expect(result.history[0].content).toContain("…（已截斷）");
    });
  });

  describe("appendMessages", () => {
    it("creates messages and updates session", async () => {
      (mockPrisma.conversationMessage.createMany as jest.Mock).mockResolvedValue({ count: 2 });
      (mockPrisma.conversationSession.update as jest.Mock).mockResolvedValue({});

      await appendMessages("session-1", [
        { role: "USER",      content: "Hello" },
        { role: "ASSISTANT", content: "Hi!" },
      ]);

      expect(mockPrisma.conversationMessage.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.arrayContaining([
            expect.objectContaining({ role: "USER",      content: "Hello",  sessionId: "session-1" }),
            expect.objectContaining({ role: "ASSISTANT", content: "Hi!",    sessionId: "session-1" }),
          ]),
        })
      );
      expect(mockPrisma.conversationSession.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "session-1" },
          data:  expect.objectContaining({ messageCount: { increment: 2 } }),
        })
      );
    });

    it("sets session title from first USER message", async () => {
      (mockPrisma.conversationMessage.createMany as jest.Mock).mockResolvedValue({ count: 1 });
      (mockPrisma.conversationSession.update as jest.Mock).mockResolvedValue({});

      await appendMessages("session-1", [
        { role: "USER", content: "我的訂單 #20240918 什麼時候到？" },
      ]);

      expect(mockPrisma.conversationSession.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            title: expect.stringContaining("我的訂單"),
          }),
        })
      );
    });
  });
});
