// src/routes/admin/permissions.ts
// 角色管理、成員邀請、權限查詢
import { Router } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { prisma } from "@/db/client";
import { requireAuth, requireAdmin, AuthRequest } from "@/middleware/auth";
import { AppError } from "@/middleware/errorHandler";
import { UserRole } from "@prisma/client";
import { PERMISSION_MATRIX, can } from "@/lib/permissions";

const router = Router();

// ── GET /api/admin/permissions/matrix  — 回傳完整權限矩陣 ────
router.get("/matrix", requireAuth, (_req, res) => {
  res.json(PERMISSION_MATRIX);
});

// ── GET /api/admin/permissions/my  — 當前使用者的權限清單 ───
router.get("/my", requireAuth, (req: AuthRequest, res) => {
  const role = (req.userRole as UserRole) ?? "VIEWER";
  res.json({ role, permissions: PERMISSION_MATRIX[role] });
});

// ── GET /api/admin/users  — 所有使用者 ──────────────────────
router.get("/users", requireAdmin, async (_req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      select: { id: true, email: true, name: true, role: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });
    res.json(users);
  } catch (e) { next(e); }
});

// ── POST /api/admin/users  — 建立使用者 ─────────────────────
router.post("/users", requireAdmin, async (req, res, next) => {
  try {
    const Schema = z.object({
      email:    z.string().email(),
      password: z.string().min(8),
      name:     z.string().optional(),
      role:     z.nativeEnum(UserRole).optional(),
    });
    const body = Schema.safeParse(req.body);
    if (!body.success) throw new AppError(400, body.error.message);

    const exists = await prisma.user.findUnique({ where: { email: body.data.email } });
    if (exists) throw new AppError(409, "Email already exists");

    const hash = await bcrypt.hash(body.data.password, 10);
    const user = await prisma.user.create({
      data: { ...body.data, passwordHash: hash },
      select: { id: true, email: true, name: true, role: true, createdAt: true },
    });
    res.status(201).json(user);
  } catch (e) { next(e); }
});

// ── PATCH /api/admin/users/:id/role  — 更改角色 ─────────────
router.patch("/users/:id/role", requireAdmin, async (req, res, next) => {
  try {
    const { role } = z.object({ role: z.nativeEnum(UserRole) }).parse(req.body);
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data:  { role },
      select: { id: true, email: true, name: true, role: true },
    });
    res.json(user);
  } catch (e) { next(e); }
});

// ── DELETE /api/admin/users/:id ──────────────────────────────
router.delete("/users/:id", requireAdmin, async (req, res, next) => {
  try {
    await prisma.user.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (e) { next(e); }
});

// ── GET /api/admin/members?workspaceId= ─────────────────────
router.get("/members", requireAuth, async (req, res, next) => {
  try {
    const { workspaceId } = req.query;
    if (!workspaceId) throw new AppError(400, "workspaceId required");
    const members = await prisma.workspaceMember.findMany({
      where:   { workspaceId: String(workspaceId) },
      include: { user: { select: { id: true, email: true, name: true } } },
      orderBy: { joinedAt: "asc" },
    });
    res.json(members);
  } catch (e) { next(e); }
});

// ── POST /api/admin/members  — 邀請成員加入 Workspace ───────
router.post("/members", requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const Schema = z.object({
      workspaceId: z.string().cuid(),
      email:       z.string().email(),
      role:        z.nativeEnum(UserRole).optional(),
    });
    const body = Schema.safeParse(req.body);
    if (!body.success) throw new AppError(400, body.error.message);

    const user = await prisma.user.findUnique({ where: { email: body.data.email } });
    if (!user) throw new AppError(404, `使用者 ${body.data.email} 不存在，請先建立帳號`);

    const member = await prisma.workspaceMember.upsert({
      where: { workspaceId_userId: { workspaceId: body.data.workspaceId, userId: user.id } },
      update: { role: body.data.role ?? "VIEWER" },
      create: {
        workspaceId: body.data.workspaceId,
        userId:      user.id,
        role:        body.data.role ?? "VIEWER",
        invitedBy:   req.userId,
      },
    });
    res.status(201).json(member);
  } catch (e) { next(e); }
});

// ── PATCH /api/admin/members/:id/role ───────────────────────
router.patch("/members/:id/role", requireAuth, async (req, res, next) => {
  try {
    const { role } = z.object({ role: z.nativeEnum(UserRole) }).parse(req.body);
    const m = await prisma.workspaceMember.update({
      where: { id: req.params.id },
      data:  { role },
    });
    res.json(m);
  } catch (e) { next(e); }
});

// ── DELETE /api/admin/members/:id ───────────────────────────
router.delete("/members/:id", requireAuth, async (req, res, next) => {
  try {
    await prisma.workspaceMember.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (e) { next(e); }
});

export default router;
