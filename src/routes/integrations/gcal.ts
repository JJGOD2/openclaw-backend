// src/routes/integrations/gcal.ts
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "@/middleware/auth";
import { calListEvents, calCreateEvent, calQuickBook } from "@/services/gcal.service";

const router = Router();
router.use(requireAuth);

// GET /api/integrations/gcal/events?workspaceId=
router.get("/events", async (req, res, next) => {
  try {
    const { workspaceId, maxResults, calendarId } = z.object({
      workspaceId: z.string().cuid(),
      maxResults:  z.coerce.number().max(50).optional(),
      calendarId:  z.string().optional(),
    }).parse(req.query);
    const events = await calListEvents(workspaceId, calendarId, maxResults);
    res.json(events);
  } catch (e) { next(e); }
});

// POST /api/integrations/gcal/events
router.post("/events", async (req, res, next) => {
  try {
    const body = z.object({
      workspaceId: z.string().cuid(),
      summary:     z.string().min(1),
      description: z.string().optional(),
      location:    z.string().optional(),
      startTime:   z.string().datetime(),
      endTime:     z.string().datetime(),
      attendees:   z.array(z.string().email()).optional(),
      calendarId:  z.string().optional(),
    }).parse(req.body);
    const { workspaceId, ...opts } = body;
    const event = await calCreateEvent(workspaceId, opts);
    res.status(201).json(event);
  } catch (e) { next(e); }
});

// POST /api/integrations/gcal/quick-book
router.post("/quick-book", async (req, res, next) => {
  try {
    const { workspaceId, title, startTime, attendees } = z.object({
      workspaceId: z.string().cuid(),
      title:       z.string().min(1),
      startTime:   z.string().datetime(),
      attendees:   z.array(z.string().email()).optional(),
    }).parse(req.body);
    const event = await calQuickBook(workspaceId, title, startTime, attendees);
    res.status(201).json(event);
  } catch (e) { next(e); }
});

export default router;
