// src/routes/usage.ts
import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/db/client";
import { requireAuth } from "@/middleware/auth";
import { AppError } from "@/middleware/errorHandler";

const router = Router();
router.use(requireAuth);

// GET /api/usage?workspaceId=&days=30
router.get("/", async (req, res, next) => {
  try {
    const Schema = z.object({
      workspaceId: z.string().optional(),
      days:        z.coerce.number().min(1).max(365).default(30),
    });
    const q = Schema.safeParse(req.query);
    if (!q.success) throw new AppError(400, q.error.message);

    const since = new Date();
    since.setDate(since.getDate() - q.data.days);

    const records = await prisma.usageRecord.findMany({
      where: {
        ...(q.data.workspaceId ? { workspaceId: q.data.workspaceId } : {}),
        date: { gte: since },
      },
      orderBy: { date: "asc" },
    });

    // Aggregate totals
    const totals = records.reduce(
      (acc, r) => ({
        inputTokens:  acc.inputTokens  + r.inputTokens,
        outputTokens: acc.outputTokens + r.outputTokens,
        apiCalls:     acc.apiCalls     + r.apiCalls,
        messages:     acc.messages     + r.messages,
        toolExecs:    acc.toolExecs    + r.toolExecs,
        costNTD:      acc.costNTD      + Number(r.costNTD),
      }),
      { inputTokens: 0, outputTokens: 0, apiCalls: 0, messages: 0, toolExecs: 0, costNTD: 0 }
    );

    res.json({ totals, records });
  } catch (e) { next(e); }
});

// POST /api/usage  — ingest daily usage record from OpenClaw gateway
router.post("/", async (req, res, next) => {
  try {
    const Schema = z.object({
      workspaceId:  z.string().cuid(),
      date:         z.string().datetime(),
      inputTokens:  z.number().int().min(0),
      outputTokens: z.number().int().min(0),
      apiCalls:     z.number().int().min(0),
      messages:     z.number().int().min(0),
      toolExecs:    z.number().int().min(0),
      costNTD:      z.number().min(0),
    });
    const body = Schema.safeParse(req.body);
    if (!body.success) throw new AppError(400, body.error.message);

    const record = await prisma.usageRecord.upsert({
      where: {
        workspaceId_date: {
          workspaceId: body.data.workspaceId,
          date:        new Date(body.data.date),
        },
      },
      update: {
        inputTokens:  { increment: body.data.inputTokens },
        outputTokens: { increment: body.data.outputTokens },
        apiCalls:     { increment: body.data.apiCalls },
        messages:     { increment: body.data.messages },
        toolExecs:    { increment: body.data.toolExecs },
        costNTD:      { increment: body.data.costNTD },
      },
      create: {
        workspaceId:  body.data.workspaceId,
        date:         new Date(body.data.date),
        inputTokens:  body.data.inputTokens,
        outputTokens: body.data.outputTokens,
        apiCalls:     body.data.apiCalls,
        messages:     body.data.messages,
        toolExecs:    body.data.toolExecs,
        costNTD:      body.data.costNTD,
      },
    });
    res.status(201).json(record);
  } catch (e) { next(e); }
});

export default router;
