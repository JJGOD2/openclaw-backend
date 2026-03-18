// src/routes/channels.ts
import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/db/client";
import { requireAuth } from "@/middleware/auth";
import { AppError } from "@/middleware/errorHandler";
import { ChannelType, ChannelStatus } from "@prisma/client";

const router = Router();
router.use(requireAuth);

// GET /api/channels?workspaceId=xxx
router.get("/", async (req, res, next) => {
  try {
    const { workspaceId } = req.query;

    if (workspaceId) {
      const bindings = await prisma.channelBinding.findMany({
        where:   { workspaceId: String(workspaceId) },
        include: {
          channel:  true,
          allowlist: { select: { id: true, senderId: true, note: true } },
        },
      });
      return res.json(bindings);
    }

    const channels = await prisma.channel.findMany({
      orderBy: { createdAt: "asc" },
      include: { bindings: { include: { workspace: { select: { client: true } } } } },
    });
    res.json(channels);
  } catch (e) { next(e); }
});

// POST /api/channels  — create channel + binding
router.post("/", async (req, res, next) => {
  try {
    const Schema = z.object({
      workspaceId:   z.string().cuid(),
      type:          z.nativeEnum(ChannelType),
      displayName:   z.string().min(1),
      handle:        z.string().min(1),
      defaultAgentId:z.string().cuid().optional(),
      dmScope:       z.enum(["restricted", "open"]).optional(),
    });
    const body = Schema.safeParse(req.body);
    if (!body.success) throw new AppError(400, body.error.message);

    const { workspaceId, defaultAgentId, dmScope, ...chanData } = body.data;

    const channel = await prisma.channel.create({ data: chanData });
    const binding = await prisma.channelBinding.create({
      data: { workspaceId, channelId: channel.id, defaultAgentId, dmScope: dmScope ?? "restricted" },
    });

    res.status(201).json({ channel, binding });
  } catch (e) { next(e); }
});

// PATCH /api/channels/:id/toggle  — enable / disable
router.patch("/:id/toggle", async (req, res, next) => {
  try {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    const ch = await prisma.channel.update({ where: { id: req.params.id }, data: { enabled } });
    res.json(ch);
  } catch (e) { next(e); }
});

// PATCH /api/channels/bindings/:bindingId  — update policy
router.patch("/bindings/:bindingId", async (req, res, next) => {
  try {
    const Schema = z.object({
      defaultAgentId: z.string().cuid().optional().nullable(),
      dmScope:        z.enum(["restricted", "open"]).optional(),
      groupEnabled:   z.boolean().optional(),
      allowlistMode:  z.boolean().optional(),
    });
    const body = Schema.safeParse(req.body);
    if (!body.success) throw new AppError(400, body.error.message);
    const binding = await prisma.channelBinding.update({
      where: { id: req.params.bindingId },
      data:  body.data,
    });
    res.json(binding);
  } catch (e) { next(e); }
});

// POST /api/channels/bindings/:bindingId/allowlist
router.post("/bindings/:bindingId/allowlist", async (req, res, next) => {
  try {
    const { senderId, note } = z.object({
      senderId: z.string().min(1),
      note:     z.string().optional(),
    }).parse(req.body);

    const entry = await prisma.senderAllowlist.create({
      data: { channelBindingId: req.params.bindingId, senderId, note },
    });
    res.status(201).json(entry);
  } catch (e) { next(e); }
});

// DELETE /api/channels/bindings/:bindingId/allowlist/:entryId
router.delete("/bindings/:bindingId/allowlist/:entryId", async (req, res, next) => {
  try {
    await prisma.senderAllowlist.delete({ where: { id: req.params.entryId } });
    res.status(204).end();
  } catch (e) { next(e); }
});

export default router;
