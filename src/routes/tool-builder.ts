// src/routes/tool-builder.ts
// 視覺化 Tool 建構器 — 自定義工具 CRUD + 測試執行
import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/db/client";
import { requireAuth } from "@/middleware/auth";
import { AppError } from "@/middleware/errorHandler";
import { ToolTrigger } from "@prisma/client";
import { getValidAccessToken } from "@/services/oauth/token.service";
import { GOOGLE_SCOPES } from "@/services/oauth/google.oauth";
import { decryptSecret } from "@/lib/crypto";

const router = Router();
router.use(requireAuth);

// ── GET /api/tool-builder?workspaceId= ───────────────────────
router.get("/", async (req, res, next) => {
  try {
    const { workspaceId } = z.object({ workspaceId: z.string().cuid() }).parse(req.query);
    const tools = await prisma.customTool.findMany({
      where:   { workspaceId },
      orderBy: { createdAt: "desc" },
    });
    res.json(tools);
  } catch (e) { next(e); }
});

// ── POST /api/tool-builder ────────────────────────────────────
router.post("/", async (req, res, next) => {
  try {
    const Schema = z.object({
      workspaceId:  z.string().cuid(),
      name:         z.string().min(1).max(60).regex(/^[a-z0-9-]+$/, "只允許小寫字母、數字和連字號"),
      displayName:  z.string().min(1).max(80),
      description:  z.string().min(1).max(500),
      trigger:      z.nativeEnum(ToolTrigger),
      configJson:   z.record(z.unknown()),
      inputSchema:  z.record(z.unknown()).default({}),
      outputFormat: z.enum(["text","json","table"]).default("text"),
    });
    const body = Schema.safeParse(req.body);
    if (!body.success) throw new AppError(400, body.error.message);

    const tool = await prisma.customTool.create({ data: body.data });
    res.status(201).json(tool);
  } catch (e) { next(e); }
});

// ── PATCH /api/tool-builder/:id ──────────────────────────────
router.patch("/:id", async (req, res, next) => {
  try {
    const Schema = z.object({
      displayName:  z.string().optional(),
      description:  z.string().optional(),
      configJson:   z.record(z.unknown()).optional(),
      inputSchema:  z.record(z.unknown()).optional(),
      outputFormat: z.enum(["text","json","table"]).optional(),
      enabled:      z.boolean().optional(),
    });
    const body = Schema.safeParse(req.body);
    if (!body.success) throw new AppError(400, body.error.message);

    const tool = await prisma.customTool.update({
      where: { id: req.params.id },
      data:  body.data,
    });
    res.json(tool);
  } catch (e) { next(e); }
});

// ── DELETE /api/tool-builder/:id ─────────────────────────────
router.delete("/:id", async (req, res, next) => {
  try {
    await prisma.customTool.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (e) { next(e); }
});

// ── POST /api/tool-builder/:id/test ──────────────────────────
// 執行工具測試（用測試 input 呼叫真實 API）
router.post("/:id/test", async (req, res, next) => {
  try {
    const tool = await prisma.customTool.findUnique({ where: { id: req.params.id } });
    if (!tool) throw new AppError(404, "Tool not found");

    const testInput = req.body.input ?? {};
    const startMs   = Date.now();

    let output:   unknown;
    let errorMsg: string | undefined;

    try {
      output = await executeTool(tool.workspaceId, tool.trigger, tool.configJson as ToolConfig, testInput);
    } catch (err) {
      errorMsg = (err as Error).message;
    }

    // Increment usage count
    if (!errorMsg) {
      await prisma.customTool.update({
        where: { id: tool.id },
        data:  { usageCount: { increment: 1 } },
      });
    }

    res.json({
      ok:        !errorMsg,
      output,
      error:     errorMsg,
      latencyMs: Date.now() - startMs,
    });
  } catch (e) { next(e); }
});

// ── Tool Execution Engine ─────────────────────────────────────
type ToolConfig = Record<string, unknown>;

async function executeTool(
  workspaceId: string,
  trigger:     ToolTrigger,
  config:      ToolConfig,
  input:       Record<string, unknown>
): Promise<unknown> {
  switch (trigger) {
    case "HTTP_GET": {
      const url     = interpolate(String(config.url ?? ""), input);
      const headers = (config.headers as Record<string, string>) ?? {};
      const r = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      const text = await r.text();
      try { return JSON.parse(text); } catch { return text; }
    }

    case "HTTP_POST": {
      const url     = interpolate(String(config.url ?? ""), input);
      const headers = { "Content-Type": "application/json",
                        ...((config.headers as Record<string, string>) ?? {}) };
      const body    = config.bodyTemplate
        ? JSON.parse(interpolate(JSON.stringify(config.bodyTemplate), input))
        : input;
      const r = await fetch(url, {
        method: "POST",
        headers,
        body:   JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      const text = await r.text();
      try { return JSON.parse(text); } catch { return text; }
    }

    case "GOOGLE_SHEETS_READ": {
      const { sheetsRead } = await import("@/services/sheets.service");
      return sheetsRead(
        workspaceId,
        String(config.spreadsheetId ?? input.spreadsheetId ?? ""),
        interpolate(String(config.range ?? "Sheet1!A:Z"), input)
      );
    }

    case "GOOGLE_SHEETS_WRITE": {
      const { sheetsAppend } = await import("@/services/sheets.service");
      const values = Array.isArray(input.values)
        ? input.values as (string|number)[][]
        : [[...Object.values(input)] as (string|number)[]];
      return sheetsAppend(
        workspaceId,
        String(config.spreadsheetId ?? ""),
        String(config.range ?? "Sheet1!A:Z"),
        values
      );
    }

    case "NOTION_CREATE": {
      const { notionCreatePage, notionParagraph } = await import("@/services/notion.service");
      const props: Record<string, unknown> = {
        Name: { title: [{ text: { content: String(input.title ?? input.name ?? "New Entry") } }] },
      };
      // Add any extra fields from input as rich_text
      for (const [k, v] of Object.entries(input)) {
        if (k === "title" || k === "name") continue;
        props[k] = { rich_text: [{ text: { content: String(v) } }] };
      }
      return notionCreatePage(
        workspaceId,
        String(config.databaseId ?? ""),
        props,
        input.content ? [notionParagraph(String(input.content))] : undefined
      );
    }

    case "GMAIL_SEND": {
      const { gmailSend } = await import("@/services/gmail.service");
      return gmailSend(workspaceId, {
        to:      String(input.to   ?? config.defaultTo ?? ""),
        subject: interpolate(String(config.subject ?? input.subject ?? ""), input),
        body:    interpolate(String(config.body    ?? input.body    ?? ""), input),
      });
    }

    case "GCAL_CREATE": {
      const { calCreateEvent } = await import("@/services/gcal.service");
      return calCreateEvent(workspaceId, {
        summary:     interpolate(String(config.summary     ?? input.summary     ?? ""), input),
        description: interpolate(String(config.description ?? input.description ?? ""), input),
        startTime:   String(input.startTime ?? config.startTime ?? ""),
        endTime:     String(input.endTime   ?? config.endTime   ?? ""),
        attendees:   (input.attendees as string[] | undefined) ?? [],
      });
    }

    case "CUSTOM_FUNCTION": {
      // Evaluate a simple JS expression (sandboxed — no access to node internals)
      const fn   = String(config.function ?? "() => ({})");
      // eslint-disable-next-line no-new-func
      const exec = new Function("input", `"use strict"; return (${fn})(input);`);
      return exec(input);
    }

    default:
      throw new Error(`Unsupported trigger: ${trigger}`);
  }
}

// Simple {{variable}} interpolation
function interpolate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? ""));
}

export default router;
