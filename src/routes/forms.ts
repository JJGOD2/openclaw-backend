// src/routes/forms.ts
import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/db/client";
import { requireAuth } from "@/middleware/auth";
import { AppError } from "@/middleware/errorHandler";
import { FormStatus } from "@prisma/client";

const router = Router();

// ── Public: submit response ───────────────────────────────────
router.post("/:formId/respond", async (req, res, next) => {
  try {
    const form = await prisma.collectForm.findUnique({ where: { id: req.params.formId } });
    if (!form) throw new AppError(404, "Form not found");
    if (form.status !== "ACTIVE") throw new AppError(400, "Form is not accepting responses");

    const { answers, userId, platform, sessionId } = z.object({
      answers:   z.record(z.unknown()),
      userId:    z.string().optional(),
      platform:  z.string().optional(),
      sessionId: z.string().optional(),
    }).parse(req.body);

    // Validate required fields
    const fields = form.fields as { key:string; label:string; required?:boolean }[];
    for (const f of fields) {
      if (f.required && !answers[f.key]) {
        return res.status(400).json({ error: `${f.label} 為必填` });
      }
    }

    const response = await prisma.formResponse.create({
      data: {
        formId:      form.id,
        workspaceId: form.workspaceId,
        userId, platform, sessionId,
        answers,
        isComplete: true,
        submittedAt: new Date(),
      },
    });
    await prisma.collectForm.update({
      where: { id: form.id },
      data:  { responseCount: { increment: 1 } },
    });

    res.json({ ok: true, responseId: response.id, message: form.successMsg ?? "感謝您的填寫！" });
  } catch (e) { next(e); }
});

// ── Authenticated routes ──────────────────────────────────────
router.use(requireAuth);

// GET /api/forms?workspaceId=
router.get("/", async (req, res, next) => {
  try {
    const { workspaceId } = z.object({ workspaceId: z.string().cuid() }).parse(req.query);
    const forms = await prisma.collectForm.findMany({
      where:   { workspaceId },
      orderBy: { createdAt: "desc" },
    });
    res.json(forms);
  } catch (e) { next(e); }
});

// POST /api/forms
router.post("/", async (req, res, next) => {
  try {
    const body = z.object({
      workspaceId: z.string().cuid(),
      name:        z.string().min(1).max(100),
      description: z.string().optional(),
      fields:      z.array(z.object({
        key:         z.string(),
        label:       z.string(),
        type:        z.string(),
        required:    z.boolean().optional(),
        options:     z.array(z.string()).optional(),
        placeholder: z.string().optional(),
      })).min(1),
      successMsg:  z.string().optional(),
      status:      z.nativeEnum(FormStatus).optional(),
    }).parse(req.body);

    const form = await prisma.collectForm.create({ data: body });
    res.status(201).json(form);
  } catch (e) { next(e); }
});

// PATCH /api/forms/:id
router.patch("/:id", async (req, res, next) => {
  try {
    const body = z.object({
      name:       z.string().optional(),
      description:z.string().optional(),
      fields:     z.array(z.record(z.unknown())).optional(),
      successMsg: z.string().optional(),
      status:     z.nativeEnum(FormStatus).optional(),
    }).parse(req.body);
    const form = await prisma.collectForm.update({ where: { id: req.params.id }, data: body });
    res.json(form);
  } catch (e) { next(e); }
});

// DELETE /api/forms/:id
router.delete("/:id", async (req, res, next) => {
  try {
    await prisma.collectForm.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (e) { next(e); }
});

// GET /api/forms/:id/responses
router.get("/:id/responses", async (req, res, next) => {
  try {
    const form      = await prisma.collectForm.findUnique({ where: { id: req.params.id } });
    if (!form) throw new AppError(404, "Form not found");

    const responses = await prisma.formResponse.findMany({
      where:   { formId: req.params.id },
      orderBy: { submittedAt: "desc" },
      take:    500,
    });
    res.json({ form, responses, count: responses.length });
  } catch (e) { next(e); }
});

// GET /api/forms/:id/responses/export — CSV export
router.get("/:id/responses/export", async (req, res, next) => {
  try {
    const form      = await prisma.collectForm.findUnique({ where: { id: req.params.id } });
    if (!form) throw new AppError(404, "Form not found");

    const fields    = form.fields as { key:string; label:string }[];
    const responses = await prisma.formResponse.findMany({
      where:   { formId: req.params.id },
      orderBy: { submittedAt: "asc" },
    });

    const header = ["提交時間","用戶ID","平台",...fields.map(f=>f.label)];
    const rows   = responses.map(r => {
      const answers = r.answers as Record<string,unknown>;
      return [
        r.submittedAt.toISOString(),
        r.userId ?? "",
        r.platform ?? "",
        ...fields.map(f => String(answers[f.key] ?? "")),
      ];
    });

    const csv = [header,...rows]
      .map(row => row.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(","))
      .join("\n");

    res.setHeader("Content-Type","text/csv; charset=utf-8");
    res.setHeader("Content-Disposition",
      `attachment; filename="form-${form.id.slice(0,8)}-${new Date().toISOString().slice(0,10)}.csv"`);
    res.send("\uFEFF" + csv);
  } catch (e) { next(e); }
});

export default router;
