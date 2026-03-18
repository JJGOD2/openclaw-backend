// src/services/security/prompt-guard.service.ts
// Prompt Injection 偵測與防護
// 在使用者輸入到達 Agent 之前先掃描

interface GuardResult {
  safe:        boolean;
  risk:        "none" | "low" | "medium" | "high" | "critical";
  triggers:    string[];   // which patterns matched
  sanitized:   string;     // cleaned version of input
  blocked:     boolean;
}

// ── Pattern definitions ───────────────────────────────────────
interface PatternDef {
  id:      string;
  name:    string;
  risk:    GuardResult["risk"];
  pattern: RegExp;
  action:  "warn" | "sanitize" | "block";
}

const PATTERNS: PatternDef[] = [
  // ── Instruction injection attempts ────────────────────────
  {
    id: "ignore-instructions",
    name: "忽略指令注入",
    risk: "critical",
    pattern: /ignore\s+(all\s+)?previous\s+instructions?|忽略.{0,10}指令|forget\s+everything|forget\s+your/i,
    action: "block",
  },
  {
    id: "system-prompt-reveal",
    name: "System Prompt 洩漏嘗試",
    risk: "high",
    pattern: /repeat\s+(your\s+)?(system\s+)?prompt|show\s+me\s+your\s+(instructions?|system)|你的\s*(系統|system)\s*(提示|prompt)|列出你的指令/i,
    action: "block",
  },
  {
    id: "role-override",
    name: "角色覆蓋嘗試",
    risk: "high",
    pattern: /you\s+are\s+now\s+(?!a\s+customer)|pretend\s+(you\s+are|to\s+be)|act\s+as\s+if\s+you\s+(have\s+no|are\s+not)|DAN\s+mode|jailbreak|你現在是(?!客服|助理|AI)/i,
    action: "block",
  },
  {
    id: "delimiter-injection",
    name: "分隔符注入",
    risk: "medium",
    pattern: /\[SYSTEM\]|\[INST\]|<<SYS>>|<\|im_start\|>|\[HUMAN\]|\[ASSISTANT\]/i,
    action: "sanitize",
  },
  {
    id: "prompt-leaking",
    name: "Prompt 竊取",
    risk: "high",
    pattern: /output\s+everything\s+above|print\s+the\s+(entire\s+)?conversation|echo\s+all\s+messages|顯示完整.{0,5}對話/i,
    action: "block",
  },
  // ── Code execution attempts ───────────────────────────────
  {
    id: "code-exec",
    name: "程式執行嘗試",
    risk: "high",
    pattern: /```python|```javascript|eval\s*\(|exec\s*\(|subprocess|os\.system|__import__/i,
    action: "sanitize",
  },
  // ── Social engineering ────────────────────────────────────
  {
    id: "authority-claim",
    name: "偽造授權聲稱",
    risk: "medium",
    pattern: /I\s+am\s+(the\s+)?(admin|administrator|developer|owner|god|root)|我是.{0,5}(管理員|開發者|創始人|老闆)/i,
    action: "warn",
  },
  {
    id: "emotional-manipulation",
    name: "情緒操控（解除限制）",
    risk: "low",
    pattern: /without\s+any\s+(restrictions?|limitations?|filters?|guidelines?)|沒有任何限制|解除你的限制/i,
    action: "warn",
  },
  // ── Data exfiltration ─────────────────────────────────────
  {
    id: "data-exfil",
    name: "資料外洩嘗試",
    risk: "critical",
    pattern: /send\s+all\s+(data|messages?|emails?)\s+to|email\s+everything\s+to|forward\s+all\s+to/i,
    action: "block",
  },
];

// ── Risk levels for blocking ──────────────────────────────────
const BLOCK_RISKS = new Set<GuardResult["risk"]>(["critical", "high"]);

// ─────────────────────────────────────────────────────────────
// Main guard function
// ─────────────────────────────────────────────────────────────
export function scanInput(text: string): GuardResult {
  const triggers: string[]         = [];
  let   maxRisk: GuardResult["risk"]= "none";
  let   shouldBlock                 = false;
  let   sanitized                   = text;

  const riskOrder: GuardResult["risk"][] = ["none","low","medium","high","critical"];

  for (const p of PATTERNS) {
    if (!p.pattern.test(text)) continue;

    triggers.push(p.id);

    // Update max risk
    if (riskOrder.indexOf(p.risk) > riskOrder.indexOf(maxRisk)) {
      maxRisk = p.risk;
    }

    if (p.action === "block" && BLOCK_RISKS.has(p.risk)) {
      shouldBlock = true;
    } else if (p.action === "sanitize") {
      sanitized = sanitized.replace(p.pattern, "[已過濾]");
    }
  }

  return {
    safe:     triggers.length === 0,
    risk:     maxRisk,
    triggers,
    sanitized: shouldBlock ? "[輸入已攔截]" : sanitized,
    blocked:   shouldBlock,
  };
}

// ─────────────────────────────────────────────────────────────
// Express middleware
// ─────────────────────────────────────────────────────────────
import { Request, Response, NextFunction } from "express";
import { prisma } from "@/db/client";

export function promptGuard(options: {
  bodyField?:    string;     // which body field to scan (default: "text")
  workspaceId?:  string;     // for logging (can also be from req.body)
  onBlocked?:    (req: Request, result: GuardResult) => void;
} = {}) {
  const { bodyField = "text" } = options;

  return async (req: Request, res: Response, next: NextFunction) => {
    const text = req.body?.[bodyField];
    if (!text || typeof text !== "string") return next();

    const result = scanInput(text);

    if (result.blocked) {
      const wsId = req.body?.workspaceId ?? options.workspaceId ?? "unknown";
      // Log the blocked attempt
      await prisma.logEntry.create({
        data: {
          workspaceId: wsId,
          type:        "WARN",
          message:     `[PromptGuard] 攔截 ${result.risk} 風險輸入：${result.triggers.join(", ")}`,
          metadata:    { risk: result.risk, triggers: result.triggers, preview: text.slice(0, 100) },
        },
      }).catch(() => {});

      options.onBlocked?.(req, result);
      return res.status(400).json({
        error:    "輸入內容包含不允許的模式，已被安全系統攔截",
        risk:     result.risk,
        triggers: result.triggers,
      });
    }

    // Sanitize and warn
    if (result.triggers.length > 0) {
      req.body[bodyField] = result.sanitized;
      const wsId = req.body?.workspaceId ?? options.workspaceId ?? "unknown";
      await prisma.logEntry.create({
        data: {
          workspaceId: wsId,
          type:        "WARN",
          message:     `[PromptGuard] 偵測到 ${result.risk} 風險，已淨化：${result.triggers.join(", ")}`,
          metadata:    { risk: result.risk, triggers: result.triggers },
        },
      }).catch(() => {});
    }

    next();
  };
}

// ── GET /api/security/guard-test — test a string against patterns
export { PATTERNS };
