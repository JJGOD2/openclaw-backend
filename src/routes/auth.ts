// src/routes/auth.ts
import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { prisma } from "@/db/client";
import { requireAuth, AuthRequest } from "@/middleware/auth";
import { AppError } from "@/middleware/errorHandler";

const router = Router();
const JWT_SECRET  = process.env.JWT_SECRET  ?? "dev-secret";
const JWT_EXPIRES = process.env.JWT_EXPIRES_IN ?? "7d";

const LoginSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(6),
});

// POST /api/auth/login
router.post("/login", async (req, res, next) => {
  try {
    const body = LoginSchema.safeParse(req.body);
    if (!body.success) throw new AppError(400, "Invalid email or password format");

    const user = await prisma.user.findUnique({ where: { email: body.data.email } });
    if (!user) throw new AppError(401, "Invalid credentials");

    const valid = await bcrypt.compare(body.data.password, user.passwordHash);
    if (!valid) throw new AppError(401, "Invalid credentials");

    const token = jwt.sign(
      { sub: user.id, role: user.role, email: user.email },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES } as jwt.SignOptions
    );

    res.json({
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    });
  } catch (e) { next(e); }
});

// GET /api/auth/me
router.get("/me", requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { id: true, email: true, name: true, role: true, createdAt: true },
    });
    if (!user) throw new AppError(404, "User not found");
    res.json(user);
  } catch (e) { next(e); }
});

export default router;
