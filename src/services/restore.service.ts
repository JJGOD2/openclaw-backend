// src/services/restore.service.ts
// 從 WorkspaceBackup snapshot 還原整個 Workspace 的設定
import { prisma } from "@/db/client";
import { encryptSecret } from "@/lib/crypto";

export interface RestoreResult {
  workspaceId: string;
  restoredAt:  Date;
  stats: {
    agents:    number;
    channels:  number;
    tools:     number;
    skills:    number;
    secrets:   number;
    templates: number;
  };
  warnings: string[];
}

// ─────────────────────────────────────────────────────────────
// 主要還原函數
// 策略：清空目標 workspace 所有資料後，從 snapshot 重建
// ─────────────────────────────────────────────────────────────
export async function restoreWorkspace(
  backupId:           string,
  targetWorkspaceId?: string,   // undefined = 還原回原 workspace；有值 = 複製到新 workspace
  opts: {
    overwrite?:      boolean;   // 是否覆蓋目標 workspace（預設 false，沒資料才還原）
    skipSecrets?:    boolean;   // 是否跳過 secrets（預設 true，因 encrypted 值不可跨環境用）
    newWorkspaceName?: string;  // 建立新 workspace 時的名稱
  } = {}
): Promise<RestoreResult> {
  const { overwrite = false, skipSecrets = true } = opts;
  const warnings: string[] = [];

  // ── 1. Load backup ────────────────────────────────────────
  const backup = await prisma.workspaceBackup.findUnique({
    where: { id: backupId },
  });
  if (!backup) throw new Error(`Backup ${backupId} not found`);

  const snap = backup.snapshotJson as WorkspaceSnapshot;
  const wsId = targetWorkspaceId ?? backup.workspaceId;

  // ── 2. Resolve target workspace ───────────────────────────
  let targetWs = await prisma.workspace.findUnique({ where: { id: wsId } });

  if (!targetWs) {
    // 建立新 workspace
    targetWs = await prisma.workspace.create({
      data: {
        id:     wsId !== backup.workspaceId ? undefined : wsId,
        name:   opts.newWorkspaceName ?? `${snap.name} (已還原)`,
        client: snap.client,
        plan:   snap.plan as never,
        status: "SETTING" as never,
      },
    });
  } else if (!overwrite) {
    // 目標已有資料，檢查是否有 agents
    const existing = await prisma.agent.count({ where: { workspaceId: targetWs.id } });
    if (existing > 0) {
      throw new Error(
        `目標 Workspace 已有資料（${existing} 個 Agent）。請使用 overwrite: true 或選擇空的 Workspace。`
      );
    }
  } else {
    // overwrite: 先清空
    await prisma.agent.deleteMany({ where: { workspaceId: targetWs.id } });
    await prisma.channelBinding.deleteMany({ where: { workspaceId: targetWs.id } });
    await prisma.workspaceTool.deleteMany({ where: { workspaceId: targetWs.id } });
    await prisma.workspaceSkill.deleteMany({ where: { workspaceId: targetWs.id } });
    if (!skipSecrets) {
      await prisma.secret.deleteMany({ where: { workspaceId: targetWs.id } });
    }
    warnings.push("目標 Workspace 原有資料已清除");
  }

  const stats = { agents: 0, channels: 0, tools: 0, skills: 0, secrets: 0, templates: 0 };

  // ── 3. Restore Agents ─────────────────────────────────────
  for (const agentSnap of snap.agents ?? []) {
    await prisma.agent.create({
      data: {
        workspaceId:  targetWs.id,
        name:         agentSnap.name,
        initials:     agentSnap.initials ?? agentSnap.name.slice(0, 2),
        role:         agentSnap.role,
        description:  agentSnap.description ?? "",
        systemPrompt: agentSnap.systemPrompt ?? "",
        replyStyle:   agentSnap.replyStyle ?? "friendly",
        status:       agentSnap.status as never,
      },
    });
    stats.agents++;
  }

  // ── 4. Restore Channel Bindings ───────────────────────────
  for (const bindSnap of snap.channels ?? []) {
    const chan = bindSnap.channel;
    if (!chan) continue;

    // Upsert channel (may already exist globally)
    const channel = await prisma.channel.upsert({
      where:  { id: chan.id ?? "__none__" },
      update: {},
      create: {
        type:        chan.type as never,
        displayName: chan.displayName,
        handle:      chan.handle,
        status:      chan.status as never,
        enabled:     chan.enabled ?? false,
      },
    }).catch(async () => {
      // channel id doesn't exist, create new
      return prisma.channel.create({
        data: {
          type:        chan.type as never,
          displayName: chan.displayName,
          handle:      chan.handle,
          status:      "DISCONNECTED" as never,
          enabled:     false,
        },
      });
    });

    await prisma.channelBinding.create({
      data: {
        workspaceId:    targetWs.id,
        channelId:      channel.id,
        dmScope:        bindSnap.dmScope ?? "restricted",
        groupEnabled:   bindSnap.groupEnabled ?? true,
        allowlistMode:  bindSnap.allowlistMode ?? false,
      },
    });
    stats.channels++;
  }

  // ── 5. Restore Tools ──────────────────────────────────────
  for (const toolSnap of snap.tools ?? []) {
    const tool = await prisma.tool.findFirst({ where: { name: toolSnap.tool?.name ?? toolSnap.name } });
    if (!tool) { warnings.push(`Tool "${toolSnap.tool?.name ?? toolSnap.name}" 不存在，已跳過`); continue; }

    await prisma.workspaceTool.upsert({
      where:  { workspaceId_toolId: { workspaceId: targetWs.id, toolId: tool.id } },
      update: { enabled: toolSnap.enabled },
      create: { workspaceId: targetWs.id, toolId: tool.id, enabled: toolSnap.enabled ?? true },
    });
    stats.tools++;
  }

  // ── 6. Restore Skills ─────────────────────────────────────
  for (const skillSnap of snap.skills ?? []) {
    const skill = await prisma.skill.findFirst({ where: { name: skillSnap.skill?.name ?? skillSnap.name } });
    if (!skill) { warnings.push(`Skill "${skillSnap.skill?.name ?? skillSnap.name}" 不存在，已跳過`); continue; }

    await prisma.workspaceSkill.upsert({
      where:  { workspaceId_skillId: { workspaceId: targetWs.id, skillId: skill.id } },
      update: {},
      create: { workspaceId: targetWs.id, skillId: skill.id, status: "PENDING" as never },
    });
    stats.skills++;
  }

  // ── 7. Restore Secrets (optional) ────────────────────────
  if (!skipSecrets) {
    for (const secretSnap of snap.secrets ?? []) {
      if (secretSnap.encryptedValue?.startsWith("PLACEHOLDER")) {
        warnings.push(`Secret "${secretSnap.name}" 為 placeholder，已跳過`);
        continue;
      }
      await prisma.secret.upsert({
        where:  { workspaceId_name: { workspaceId: targetWs.id, name: secretSnap.name } },
        update: { encryptedValue: secretSnap.encryptedValue, status: secretSnap.status as never },
        create: {
          workspaceId:    targetWs.id,
          name:           secretSnap.name,
          encryptedValue: secretSnap.encryptedValue,
          status:         secretSnap.status as never,
        },
      });
      stats.secrets++;
    }
  } else {
    warnings.push("Secrets 已跳過（skipSecrets=true），請手動重新設定 API Keys");
  }

  // ── 8. Log ────────────────────────────────────────────────
  await prisma.logEntry.create({
    data: {
      workspaceId: targetWs.id,
      type:        "SYSTEM",
      message:     `[Restore] 從備份 ${backupId} 還原完成：${stats.agents} Agents, ${stats.channels} Channels, ${stats.tools} Tools`,
      metadata:    { backupId, stats, warnings },
    },
  });

  return { workspaceId: targetWs.id, restoredAt: new Date(), stats, warnings };
}

// ─────────────────────────────────────────────────────────────
// Snapshot 型別（對應 prisma/seed 的 backup snapshotJson 結構）
// ─────────────────────────────────────────────────────────────
interface WorkspaceSnapshot {
  id:      string;
  name:    string;
  client:  string;
  plan:    string;
  agents:  AgentSnap[];
  channels:BindingSnap[];
  tools:   WorkspaceToolSnap[];
  skills:  WorkspaceSkillSnap[];
  secrets: SecretSnap[];
}
interface AgentSnap {
  name: string; initials?: string; role: string;
  description?: string; systemPrompt?: string;
  replyStyle?: string; status: string;
}
interface BindingSnap {
  dmScope?: string; groupEnabled?: boolean; allowlistMode?: boolean;
  channel?: { id?: string; type: string; displayName: string; handle: string; status: string; enabled: boolean };
}
interface WorkspaceToolSnap {
  name?: string; enabled: boolean;
  tool?: { name: string };
}
interface WorkspaceSkillSnap {
  name?: string;
  skill?: { name: string };
}
interface SecretSnap {
  name: string; encryptedValue: string; status: string;
}
