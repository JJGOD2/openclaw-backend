// src/routes/export.ts
// 對話紀錄匯出：CSV / JSON / Markdown
import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/db/client";
import { requireAuth } from "@/middleware/auth";
import { AppError } from "@/middleware/errorHandler";

const router = Router();
router.use(requireAuth);

// ── GET /api/export/sessions?workspaceId=&format=&platform=&days= ─
router.get("/sessions", async (req, res, next) => {
  try {
    const { workspaceId, format, platform, days } = z.object({
      workspaceId: z.string().cuid(),
      format:      z.enum(["csv", "json", "markdown"]).default("csv"),
      platform:    z.string().optional(),
      days:        z.coerce.number().min(1).max(365).default(30),
    }).parse(req.query);

    const since    = new Date();
    since.setDate(since.getDate() - days);

    const sessions = await prisma.conversationSession.findMany({
      where: {
        workspaceId,
        ...(platform ? { platform: platform.toUpperCase() } : {}),
        lastActiveAt: { gte: since },
      },
      include: {
        messages: { orderBy: { createdAt: "asc" }, where: { role: { not: "SYSTEM" } } },
        workspace:{ select: { client: true, name: true } },
      },
      orderBy: { lastActiveAt: "desc" },
      take:    5000,
    });

    const filename = `conversations-${workspaceId.slice(0,8)}-${new Date().toISOString().slice(0,10)}`;

    if (format === "csv") {
      const rows = [["Session ID", "Platform", "User ID", "Title", "Date", "Role", "Message", "Tokens"]];
      for (const s of sessions) {
        for (const m of s.messages) {
          rows.push([
            s.id, s.platform, s.userId,
            (s.title ?? "").replace(/"/g, '""'),
            m.createdAt.toISOString(),
            m.role,
            m.content.replace(/"/g, '""').replace(/\n/g, " "),
            String(m.tokenCount ?? ""),
          ]);
        }
      }
      const csv = rows.map(r => r.map(c => `"${c}"`).join(",")).join("\n");
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}.csv"`);
      res.setHeader("X-Total-Sessions", String(sessions.length));
      return res.send("\uFEFF" + csv);   // BOM for Excel
    }

    if (format === "json") {
      const data = sessions.map(s => ({
        id:           s.id,
        platform:     s.platform,
        userId:       s.userId,
        title:        s.title,
        workspace:    s.workspace.client,
        lastActiveAt: s.lastActiveAt,
        messages:     s.messages.map(m => ({
          role:      m.role,
          content:   m.content,
          tokens:    m.tokenCount,
          createdAt: m.createdAt,
        })),
      }));
      res.setHeader("Content-Disposition", `attachment; filename="${filename}.json"`);
      return res.json(data);
    }

    if (format === "markdown") {
      const lines: string[] = [`# 對話匯出 — ${workspaceId}\n`, `> 匯出日期：${new Date().toLocaleString("zh-TW")} | ${sessions.length} 段對話\n`];
      for (const s of sessions) {
        lines.push(`\n---\n\n## ${s.title ?? `Session ${s.id.slice(0, 8)}`}`);
        lines.push(`\n**平台**：${s.platform} | **用戶**：${s.userId} | **日期**：${s.lastActiveAt.toLocaleDateString("zh-TW")}\n`);
        for (const m of s.messages) {
          const prefix = m.role === "USER" ? "👤 **用戶**" : "🤖 **AI**";
          lines.push(`\n${prefix}（${m.createdAt.toLocaleTimeString("zh-TW")}）\n\n${m.content}\n`);
        }
      }
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}.md"`);
      return res.send(lines.join("\n"));
    }

  } catch (e) { next(e); }
});

// ── GET /api/export/session/:id?format= — single session ──────
router.get("/session/:id", async (req, res, next) => {
  try {
    const { format } = z.object({
      format: z.enum(["csv", "json", "markdown"]).default("json"),
    }).parse(req.query);

    const session = await prisma.conversationSession.findUnique({
      where:   { id: req.params.id },
      include: {
        messages: { orderBy: { createdAt: "asc" }, where: { role: { not: "SYSTEM" } } },
        workspace:{ select: { client: true, name: true } },
      },
    });
    if (!session) throw new AppError(404, "Session not found");

    const filename = `session-${session.id.slice(0,8)}-${session.platform.toLowerCase()}`;

    if (format === "json") {
      res.setHeader("Content-Disposition", `attachment; filename="${filename}.json"`);
      return res.json(session);
    }

    if (format === "markdown") {
      const lines = [
        `# ${session.title ?? "對話紀錄"}`,
        `\n**平台**：${session.platform} | **用戶**：${session.userId}`,
        `**Workspace**：${session.workspace.client}\n`,
      ];
      for (const m of session.messages) {
        lines.push(m.role === "USER"
          ? `\n> 👤 **${session.userId}**（${m.createdAt.toLocaleTimeString("zh-TW")}）\n\n${m.content}`
          : `\n🤖 **AI**（${m.createdAt.toLocaleTimeString("zh-TW")}）\n\n${m.content}`
        );
      }
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}.md"`);
      return res.send(lines.join("\n"));
    }

    // CSV
    const rows = [["Time", "Role", "Message", "Tokens"],
      ...session.messages.map(m => [
        m.createdAt.toISOString(), m.role,
        m.content.replace(/"/g,'""').replace(/\n/g," "),
        String(m.tokenCount ?? ""),
      ])
    ];
    const csv = rows.map(r => r.map(c => `"${c}"`).join(",")).join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}.csv"`);
    res.send("\uFEFF" + csv);
  } catch (e) { next(e); }
});

// ── GET /api/export/usage?workspaceId=&months= ─────────────────
router.get("/usage", async (req, res, next) => {
  try {
    const { workspaceId, months } = z.object({
      workspaceId: z.string().cuid(),
      months:      z.coerce.number().min(1).max(24).default(3),
    }).parse(req.query);

    const since = new Date();
    since.setMonth(since.getMonth() - months);

    const records = await prisma.usageRecord.findMany({
      where:   { workspaceId, date: { gte: since } },
      orderBy: { date: "asc" },
    });

    const header = ["Date","Messages","Input Tokens","Output Tokens","API Calls","Tool Execs","Cost NTD"];
    const rows   = records.map(r => [
      r.date.toISOString().slice(0,10),
      String(r.messages), String(r.inputTokens), String(r.outputTokens),
      String(r.apiCalls), String(r.toolExecs),   String(Number(r.costNTD).toFixed(2)),
    ]);
    const csv = [header, ...rows].map(r => r.map(c => `"${c}"`).join(",")).join("\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="usage-${workspaceId.slice(0,8)}-${months}mo.csv"`);
    res.send("\uFEFF" + csv);
  } catch (e) { next(e); }
});

export default router;
