// src/services/gateway.service.ts
// OpenClaw Gateway config 管理：從 DB 狀態組裝 JSON5 → 驗證 → 推送
import { prisma } from "@/db/client";
import { decryptSecret } from "@/lib/crypto";

export interface GatewayPushResult {
  ok:           boolean;
  message:      string;
  configPreview: string;
}

// ── Build OpenClaw config JSON from DB ───────────────────────
export async function buildGatewayConfig(workspaceId: string): Promise<object> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    include: {
      agents: {
        where: { status: "ENABLED" },
        include: {
          toolBindings:    { include: { tool: true } },
          channelBindings: {
            include: {
              binding: {
                include: {
                  channel:   true,
                  allowlist: true,
                },
              },
            },
          },
          promptTemplates: { take: 1 },
        },
      },
      secrets: true,
    },
  });
  if (!workspace) throw new Error(`Workspace ${workspaceId} not found`);

  // Decrypt secrets for config
  const secretMap: Record<string, string> = {};
  for (const s of workspace.secrets) {
    const val = s.encryptedValue.startsWith("PLACEHOLDER")
      ? `<${s.name}>`
      : decryptSecret(s.encryptedValue);
    secretMap[s.name] = val;
  }

  // Build agents config
  const agentsConfig = workspace.agents.map((agent) => ({
    id:          agent.id,
    name:        agent.name,
    role:        agent.role,
    system:      agent.systemPrompt || `你是 ${agent.name}，${agent.role}。`,
    reply_style: agent.replyStyle,
    tools:       agent.toolBindings.map((tb) => tb.tool.name),
    channels:    agent.channelBindings.map((cb) => cb.binding.channel.type.toLowerCase()),
  }));

  // Build channels config
  const channelBindings = await prisma.channelBinding.findMany({
    where:   { workspaceId },
    include: { channel: true, allowlist: true },
  });

  const channelsConfig = channelBindings.map((b) => ({
    type:           b.channel.type.toLowerCase(),
    handle:         b.channel.handle,
    enabled:        b.channel.enabled,
    default_agent:  b.defaultAgentId,
    dm_scope:       b.dmScope,
    group_enabled:  b.groupEnabled,
    allowlist_mode: b.allowlistMode,
    allowlist:      b.allowlist.map((a) => a.senderId),
  }));

  // Build security config
  const securityConfig = {
    gateway_bind:    "127.0.0.1",   // loopback only (enforced)
    inbound_dm:      "restricted",
    pairing_secure:  true,
    skill_review:    true,
  };

  return {
    workspace: {
      id:   workspaceId,
      name: `${workspace.client} — ${workspace.name}`,
    },
    anthropic: {
      api_key: secretMap["ANTHROPIC_API_KEY"] ?? "<ANTHROPIC_API_KEY>",
      model:   "claude-sonnet-4-20250514",
    },
    agents:   agentsConfig,
    channels: channelsConfig,
    security: securityConfig,
  };
}

// ── Validate config (basic checks) ──────────────────────────
export function validateConfig(config: object): { ok: boolean; message: string } {
  const c = config as Record<string, unknown>;

  if (!c.anthropic || !(c.anthropic as Record<string, unknown>).api_key) {
    return { ok: false, message: "缺少 Anthropic API Key" };
  }
  if (!Array.isArray(c.agents) || (c.agents as unknown[]).length === 0) {
    return { ok: false, message: "未設定任何 Agent" };
  }
  if (!Array.isArray(c.channels) || (c.channels as unknown[]).length === 0) {
    return { ok: false, message: "未設定任何通道" };
  }
  const hasDisabledSecurity =
    (c.security as Record<string, unknown>)?.gateway_bind !== "127.0.0.1";
  if (hasDisabledSecurity) {
    return { ok: false, message: "警告：Gateway bind 不是 loopback，存在安全風險" };
  }
  return { ok: true, message: "Config 驗證通過" };
}

// ── Push config to OpenClaw gateway via HTTP ─────────────────
export async function pushConfigToGateway(
  workspaceId:  string,
  gatewayUrl:   string,
  config:       object
): Promise<GatewayPushResult> {
  const configStr = JSON.stringify(config, null, 2);

  try {
    // OpenClaw gateway admin endpoint (assumed)
    const res = await fetch(`${gatewayUrl}/admin/config`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    configStr,
      signal:  AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      const errText = await res.text();
      return { ok: false, message: `Gateway 回應錯誤：${errText}`, configPreview: configStr };
    }

    // Update DB record
    await prisma.gatewayConfig.upsert({
      where:  { workspaceId },
      update: {
        configJson:   config,
        rawJson5:     configStr,
        lastPushedAt: new Date(),
        lastValidAt:  new Date(),
        validationOk: true,
        validationMsg:"Config 已成功推送至 Gateway",
      },
      create: {
        workspaceId,
        configJson:   config,
        rawJson5:     configStr,
        lastPushedAt: new Date(),
        lastValidAt:  new Date(),
        validationOk: true,
        validationMsg:"Config 已成功推送至 Gateway",
      },
    });

    await prisma.logEntry.create({
      data: {
        workspaceId,
        type:    "SYSTEM",
        message: `[Gateway] Config 推送成功 → ${gatewayUrl}`,
      },
    });

    return { ok: true, message: "Config 已成功推送至 Gateway", configPreview: configStr };

  } catch (err) {
    const msg = `Gateway 推送失敗：${(err as Error).message}`;
    await prisma.logEntry.create({
      data: { workspaceId, type: "ERROR", message: `[Gateway] ${msg}` },
    });
    return { ok: false, message: msg, configPreview: configStr };
  }
}
