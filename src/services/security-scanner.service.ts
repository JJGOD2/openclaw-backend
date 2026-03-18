// src/services/security-scanner.service.ts
// 進階安全掃描器 — 自動化安全檢查清單
import { prisma } from "@/db/client";

export interface ScanResult {
  id:       string;
  category: string;
  check:    string;
  severity: "CRITICAL"|"HIGH"|"MEDIUM"|"LOW"|"INFO";
  status:   "PASS"|"FAIL"|"WARN"|"SKIP";
  detail:   string;
  fix?:     string;
}

// ─────────────────────────────────────────────────────────────
// Run full security scan on a workspace
// ─────────────────────────────────────────────────────────────
export async function runSecurityScan(workspaceId: string): Promise<{
  results:     ScanResult[];
  score:       number;
  criticalCount:number;
  highCount:   number;
}> {
  const ws = await prisma.workspace.findUnique({
    where:   { id: workspaceId },
    include: {
      agents:   { include: { toolBindings: { include: { tool: true } } } },
      secrets:  true,
      channels: { include: { channel: true } },
      tools:    { include: { tool: true } },
    },
  });
  if (!ws) throw new Error("Workspace not found");

  const results: ScanResult[] = [];
  const now = new Date();

  // ── 1. Secrets checks ────────────────────────────────────
  const secrets = ws.secrets;
  const apiKey  = secrets.find(s => s.name === "ANTHROPIC_API_KEY");

  results.push({
    id: "sec-001", category: "Secrets",
    check:  "Anthropic API Key 已設定",
    severity:"CRITICAL",
    status: apiKey ? "PASS" : "FAIL",
    detail: apiKey ? "API Key 已設定並加密儲存" : "未設定 ANTHROPIC_API_KEY，Agent 無法運作",
    fix:    apiKey ? undefined : "前往 Security → Secrets 新增 ANTHROPIC_API_KEY",
  });

  // Check for expiring secrets
  const expiringSecrets = secrets.filter(s =>
    s.expiresAt && s.expiresAt > now &&
    (s.expiresAt.getTime() - now.getTime()) < 30 * 24 * 3600_000
  );
  results.push({
    id: "sec-002", category: "Secrets",
    check:    "Secrets 到期狀態",
    severity: "HIGH",
    status:   expiringSecrets.length > 0 ? "WARN" : "PASS",
    detail:   expiringSecrets.length > 0
      ? `${expiringSecrets.map(s=>s.name).join("、")} 將在 30 天內到期`
      : "所有 Secrets 皆在有效期內",
    fix: expiringSecrets.length > 0 ? "請及時更新即將到期的 Secrets" : undefined,
  });

  // Placeholder secrets check
  const placeholders = secrets.filter(s => s.encryptedValue.startsWith("PLACEHOLDER"));
  results.push({
    id: "sec-003", category: "Secrets",
    check:    "無 Placeholder 憑證",
    severity: "HIGH",
    status:   placeholders.length > 0 ? "FAIL" : "PASS",
    detail:   placeholders.length > 0
      ? `${placeholders.map(s=>s.name).join("、")} 仍為預設 placeholder 值`
      : "所有憑證均已設定真實值",
    fix: "請替換所有 PLACEHOLDER 值為真實憑證",
  });

  // ── 2. Agent security checks ──────────────────────────────
  for (const agent of ws.agents) {
    // System prompt injection check
    const promptLower = (agent.systemPrompt ?? "").toLowerCase();
    const injectKeywords = ["ignore previous", "disregard", "forget all", "you are now", "act as if"];
    const hasInjection = injectKeywords.some(k => promptLower.includes(k));
    results.push({
      id: `sec-agent-${agent.id}-inject`, category: "Prompt Safety",
      check:    `${agent.name} Prompt 安全`,
      severity: "CRITICAL",
      status:   hasInjection ? "FAIL" : "PASS",
      detail:   hasInjection ? "System Prompt 可能包含 Prompt Injection 弱點關鍵字" : "未偵測到明顯 Prompt Injection 風險",
      fix:      hasInjection ? "移除可能被利用的指令覆蓋語句" : undefined,
    });

    // High-risk tools without approval
    const highRiskNoApproval = agent.toolBindings.filter(
      tb => tb.tool.risk === "HIGH" && !tb.tool.requireApproval
    );
    results.push({
      id: `sec-agent-${agent.id}-highrisk`, category: "Tool Security",
      check:    `${agent.name} 高風險 Tool 審核`,
      severity: "HIGH",
      status:   highRiskNoApproval.length > 0 ? "WARN" : "PASS",
      detail:   highRiskNoApproval.length > 0
        ? `高風險 Tool 未啟用審核：${highRiskNoApproval.map(tb=>tb.tool.name).join("、")}`
        : "所有高風險 Tool 均已啟用人工審核",
      fix: "在 Tools 頁面為高風險工具啟用 requireApproval",
    });
  }

  // ── 3. Channel security ───────────────────────────────────
  const bindingsWithoutAllowlist = ws.channels.filter(b => !b.allowlistMode);
  results.push({
    id: "sec-ch-001", category: "Channel Security",
    check:    "Channel Allowlist 設定",
    severity: "MEDIUM",
    status:   bindingsWithoutAllowlist.length > 0 ? "WARN" : "PASS",
    detail:   bindingsWithoutAllowlist.length > 0
      ? `${bindingsWithoutAllowlist.length} 個通道未啟用 Allowlist，任何人皆可傳訊`
      : "所有通道均已啟用 Allowlist 過濾",
    fix: "在 Channels 頁面啟用 Sender Allowlist",
  });

  // ── 4. Gateway security ───────────────────────────────────
  const gatewayUrl = ws.gatewayUrl ?? "";
  results.push({
    id: "sec-gw-001", category: "Gateway",
    check:    "Gateway URL 已設定",
    severity: "CRITICAL",
    status:   gatewayUrl ? "PASS" : "FAIL",
    detail:   gatewayUrl ? `Gateway URL：${gatewayUrl}` : "尚未設定 Gateway URL",
    fix:      gatewayUrl ? undefined : "在 Gateway 頁面設定 OpenClaw Gateway URL",
  });

  const isLocalhost = gatewayUrl.includes("localhost") || gatewayUrl.includes("127.0.0.1");
  if (gatewayUrl && ws.status === "LIVE") {
    results.push({
      id: "sec-gw-002", category: "Gateway",
      check:    "Gateway URL 不指向本機（生產環境）",
      severity: "HIGH",
      status:   isLocalhost ? "WARN" : "PASS",
      detail:   isLocalhost ? "Gateway URL 指向 localhost，生產環境應使用正式伺服器 URL" : "Gateway URL 已設定為外部 URL",
      fix:      isLocalhost ? "將 Gateway URL 改為正式伺服器位址" : undefined,
    });
  }

  // ── 5. Usage anomalies ────────────────────────────────────
  const recentAnomalies = await prisma.anomalyEvent.count({
    where: {
      workspaceId,
      acknowledged: false,
      createdAt: { gte: new Date(Date.now() - 24*3600_000) },
    },
  });
  results.push({
    id: "sec-anomaly-001", category: "Monitoring",
    check:    "無未處理異常事件",
    severity: "MEDIUM",
    status:   recentAnomalies > 0 ? "WARN" : "PASS",
    detail:   recentAnomalies > 0
      ? `有 ${recentAnomalies} 個未確認異常事件（24小時內）`
      : "無待處理異常事件",
    fix: recentAnomalies > 0 ? "前往通知中心確認異常事件" : undefined,
  });

  // ── 6. RBAC check ─────────────────────────────────────────
  const members = await prisma.workspaceMember.count({ where: { workspaceId } });
  results.push({
    id: "sec-rbac-001", category: "Access Control",
    check:    "已設定成員與角色",
    severity: "LOW",
    status:   members > 0 ? "PASS" : "INFO",
    detail:   members > 0
      ? `已設定 ${members} 位成員`
      : "尚未設定 Workspace 成員角色（僅限 Admin 存取）",
  });

  // ── Calculate score ───────────────────────────────────────
  const weights:Record<string,number> = { CRITICAL:30, HIGH:15, MEDIUM:8, LOW:3, INFO:1 };
  const maxScore = results.reduce((s,r) => s + (weights[r.severity]??1), 0);
  const penalties= results
    .filter(r => r.status==="FAIL" || r.status==="WARN")
    .reduce((s,r) => s + (weights[r.severity]??1) * (r.status==="FAIL"?1:0.5), 0);
  const score = Math.round(Math.max(0, (1 - penalties/maxScore)) * 100);

  return {
    results,
    score,
    criticalCount: results.filter(r => r.severity==="CRITICAL" && r.status==="FAIL").length,
    highCount:     results.filter(r => r.severity==="HIGH" && (r.status==="FAIL"||r.status==="WARN")).length,
  };
}
