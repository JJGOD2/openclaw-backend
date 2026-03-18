// src/routes/integrations/gmail.ts
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "@/middleware/auth";
import {
  gmailListInbox, gmailCreateDraft, gmailSend,
  gmailSendDraft, gmailUnreadCount,
} from "@/services/gmail.service";

const router = Router();
router.use(requireAuth);

// GET /api/integrations/gmail/inbox?workspaceId=
router.get("/inbox", async (req, res, next) => {
  try {
    const { workspaceId, limit, query } = z.object({
      workspaceId: z.string().cuid(),
      limit:       z.coerce.number().max(50).optional(),
      query:       z.string().optional(),
    }).parse(req.query);
    const messages = await gmailListInbox(workspaceId, limit, query);
    res.json(messages);
  } catch (e) { next(e); }
});

// GET /api/integrations/gmail/unread?workspaceId=
router.get("/unread", async (req, res, next) => {
  try {
    const { workspaceId } = z.object({ workspaceId: z.string().cuid() }).parse(req.query);
    const count = await gmailUnreadCount(workspaceId);
    res.json({ count });
  } catch (e) { next(e); }
});

// POST /api/integrations/gmail/draft
router.post("/draft", async (req, res, next) => {
  try {
    const body = z.object({
      workspaceId: z.string().cuid(),
      to:          z.string().email(),
      subject:     z.string().min(1),
      body:        z.string().min(1),
      from:        z.string().optional(),
    }).parse(req.body);
    const { workspaceId, ...opts } = body;
    const result = await gmailCreateDraft(workspaceId, opts);
    res.status(201).json(result);
  } catch (e) { next(e); }
});

// POST /api/integrations/gmail/send
router.post("/send", async (req, res, next) => {
  try {
    const body = z.object({
      workspaceId: z.string().cuid(),
      to:          z.string().email(),
      subject:     z.string().min(1),
      body:        z.string().min(1),
    }).parse(req.body);
    const { workspaceId, ...opts } = body;
    const result = await gmailSend(workspaceId, opts);
    res.json(result);
  } catch (e) { next(e); }
});

// POST /api/integrations/gmail/send-draft
router.post("/send-draft", async (req, res, next) => {
  try {
    const { workspaceId, draftId } = z.object({
      workspaceId: z.string().cuid(),
      draftId:     z.string().min(1),
    }).parse(req.body);
    const result = await gmailSendDraft(workspaceId, draftId);
    res.json(result);
  } catch (e) { next(e); }
});

export default router;
