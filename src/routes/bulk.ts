// src/routes/bulk.ts
// 批量操作 API
import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/db/client";
import { requireAuth } from "@/middleware/auth";
import { AppError } from "@/middleware/errorHandler";
import { AgentStatus } from "@prisma/client";

const router = Router();
router.use(requireAuth);

// ── POST /api/bulk/agents/status ─────────────────────────────
// 批量修改多個 Agent 的狀態
router.post("/agents/status", async (req, res, next) => {
  try {
    const { agentIds, status } = z.object({
      agentIds: z.array(z.string().cuid()).min(1).max(50),
      status:   z.nativeEnum(AgentStatus),
    }).parse(req.body);

    const result = await prisma.agent.updateMany({
      where: { id: { in: agentIds } },
      data:  { status },
    });
    res.json({ updated: result.count });
  } catch (e) { next(e); }
});

// ── POST /api/bulk/channels/toggle ───────────────────────────
// 批量啟用/停用通道
router.post("/channels/toggle", async (req, res, next) => {
  try {
    const { channelIds, enabled } = z.object({
      channelIds: z.array(z.string().cuid()).min(1).max(20),
      enabled:    z.boolean(),
    }).parse(req.body);

    const result = await prisma.channel.updateMany({
      where: { id: { in: channelIds } },
      data:  { enabled },
    });
    res.json({ updated: result.count });
  } catch (e) { next(e); }
});

// ── POST /api/bulk/tools/toggle ──────────────────────────────
// 批量啟用/停用 Workspace 的多個 Tools
router.post("/tools/toggle", async (req, res, next) => {
  try {
    const { workspaceId, toolIds, enabled } = z.object({
      workspaceId: z.string().cuid(),
      toolIds:     z.array(z.string().cuid()).min(1).max(50),
      enabled:     z.boolean(),
    }).parse(req.body);

    const result = await prisma.workspaceTool.updateMany({
      where: { workspaceId, toolId: { in: toolIds } },
      data:  { enabled },
    });
    res.json({ updated: result.count });
  } catch (e) { next(e); }
});

// ── POST /api/bulk/logs/clear ─────────────────────────────────
// 清除 N 天前的舊 logs（節省儲存空間）
router.post("/logs/clear", async (req, res, next) => {
  try {
    const { workspaceId, olderThanDays } = z.object({
      workspaceId:    z.string().cuid(),
      olderThanDays:  z.number().min(7).max(365).default(90),
    }).parse(req.body);

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - olderThanDays);

    const result = await prisma.logEntry.deleteMany({
      where: { workspaceId, createdAt: { lt: cutoff } },
    });
    res.json({ deleted: result.count, cutoffDate: cutoff.toISOString() });
  } catch (e) { next(e); }
});

// ── POST /api/bulk/workspace/copy ────────────────────────────
// 快速複製 Workspace 設定到新客戶（不含 Secrets 和 logs）
router.post("/workspace/copy", async (req, res, next) => {
  try {
    const { sourceId, newName, newClient } = z.object({
      sourceId:  z.string().cuid(),
      newName:   z.string().min(1).max(80),
      newClient: z.string().min(1).max(80),
    }).parse(req.body);

    const source = await prisma.workspace.findUnique({
      where:   { id: sourceId },
      include: {
        agents: { include: { toolBindings: true, promptTemplates: true } },
        tools:  { include: { tool: true } },
        skills: true,
      },
    });
    if (!source) throw new AppError(404, "Source workspace not found");

    const newWs = await prisma.$transaction(async (tx) => {
      // Create workspace
      const ws = await tx.workspace.create({
        data: { name: newName, client: newClient, plan: source.plan, status: "SETTING" },
      });

      // Copy agents
      for (const agent of source.agents) {
        const newAgent = await tx.agent.create({
          data: {
            workspaceId:  ws.id,
            name:         agent.name,
            initials:     agent.initials,
            role:         agent.role,
            description:  agent.description,
            systemPrompt: agent.systemPrompt,
            replyStyle:   agent.replyStyle,
            status:       agent.status,
          },
        });
        // Copy prompt templates
        for (const tmpl of agent.promptTemplates) {
          await tx.promptTemplate.create({
            data: { agentId: newAgent.id, name: tmpl.name, content: tmpl.content, category: tmpl.category },
          });
        }
        // Copy tool bindings
        for (const tb of agent.toolBindings) {
          await tx.agentTool.create({ data: { agentId: newAgent.id, toolId: tb.toolId } }).catch(() => {});
        }
      }

      // Copy workspace tool settings
      for (const wt of source.tools) {
        await tx.workspaceTool.create({
          data: { workspaceId: ws.id, toolId: wt.toolId, enabled: wt.enabled },
        }).catch(() => {});
      }

      // Copy skill settings
      for (const ws2 of source.skills) {
        await tx.workspaceSkill.create({
          data: { workspaceId: ws.id, skillId: ws2.skillId, status: "PENDING" },
        }).catch(() => {});
      }

      return ws;
    });

    await prisma.logEntry.create({
      data: {
        workspaceId: newWs.id,
        type:        "SYSTEM",
        message:     `[Bulk] Workspace 已從 ${source.client} 複製建立，包含 ${source.agents.length} 個 Agent`,
      },
    });

    res.status(201).json({ newWorkspaceId: newWs.id, name: newWs.name, client: newWs.client });
  } catch (e) { next(e); }
});

// ── POST /api/bulk/review/auto-approve ───────────────────────
// 批量自動核准低風險、超過 N 小時的審核項目
router.post("/review/auto-approve", async (req, res, next) => {
  try {
    const { workspaceId, olderThanHours } = z.object({
      workspaceId:     z.string().cuid(),
      olderThanHours:  z.number().min(1).max(72).default(24),
    }).parse(req.body);

    const cutoff = new Date(Date.now() - olderThanHours * 3600_000);

    // Only auto-approve if no high-risk keywords
    const pending = await prisma.reviewQueue.findMany({
      where: { workspaceId, status: "PENDING", createdAt: { lt: cutoff } },
    });

    const highRiskPattern = /退款|取消|刪除|退貨|終止|投訴/;
    const toApprove = pending.filter(item => !highRiskPattern.test(item.userMessage));

    if (toApprove.length > 0) {
      await prisma.reviewQueue.updateMany({
        where: { id: { in: toApprove.map(i => i.id) } },
        data:  { status: "APPROVED", reviewedBy: "auto-approve", reviewedAt: new Date(), sentAt: new Date() },
      });
    }

    res.json({
      total:    pending.length,
      approved: toApprove.length,
      skipped:  pending.length - toApprove.length,
    });
  } catch (e) { next(e); }
});

export default router;
