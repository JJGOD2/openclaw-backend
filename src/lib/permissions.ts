// src/lib/permissions.ts
// 角色權限矩陣定義
import { UserRole, PermissionResource, PermissionAction } from "@prisma/client";

type Matrix = Partial<Record<UserRole, Partial<Record<PermissionResource, PermissionAction[]>>>>;

// ── Permission Matrix ─────────────────────────────────────────
// ADMIN:    完全存取
// OPERATOR: 可讀寫業務資料，不可刪除 Workspace、不可管理使用者
// VIEWER:   唯讀，不可看 Secrets、不可推送 Gateway
export const PERMISSION_MATRIX: Matrix = {
  ADMIN: {
    WORKSPACE:  ["VIEW","CREATE","UPDATE","DELETE","MANAGE"],
    AGENT:      ["VIEW","CREATE","UPDATE","DELETE","MANAGE"],
    CHANNEL:    ["VIEW","CREATE","UPDATE","DELETE","MANAGE"],
    TOOL:       ["VIEW","CREATE","UPDATE","DELETE","MANAGE"],
    SKILL:      ["VIEW","CREATE","UPDATE","DELETE","APPROVE","MANAGE"],
    SECRET:     ["VIEW","CREATE","UPDATE","DELETE","MANAGE"],
    LOG:        ["VIEW","MANAGE"],
    USAGE:      ["VIEW","MANAGE"],
    SECURITY:   ["VIEW","MANAGE"],
    REVIEW:     ["VIEW","APPROVE","MANAGE"],
    GATEWAY:    ["VIEW","PUSH","MANAGE"],
    TEMPLATE:   ["VIEW","CREATE","UPDATE","DELETE","MANAGE"],
    ALERT:      ["VIEW","CREATE","UPDATE","DELETE","MANAGE"],
    WHITELABEL: ["VIEW","CREATE","UPDATE","DELETE","MANAGE"],
    API_KEY:    ["VIEW","CREATE","UPDATE","DELETE","MANAGE"],
    USER:       ["VIEW","CREATE","UPDATE","DELETE","MANAGE"],
  },
  OPERATOR: {
    WORKSPACE:  ["VIEW","UPDATE"],
    AGENT:      ["VIEW","CREATE","UPDATE"],
    CHANNEL:    ["VIEW","CREATE","UPDATE"],
    TOOL:       ["VIEW","UPDATE"],
    SKILL:      ["VIEW","UPDATE","APPROVE"],
    SECRET:     [],                             // ← OPERATOR 不可看 secrets
    LOG:        ["VIEW"],
    USAGE:      ["VIEW"],
    SECURITY:   ["VIEW"],
    REVIEW:     ["VIEW","APPROVE"],
    GATEWAY:    ["VIEW","PUSH"],
    TEMPLATE:   ["VIEW","CREATE","UPDATE"],
    ALERT:      ["VIEW","CREATE","UPDATE"],
    WHITELABEL: ["VIEW"],
    API_KEY:    ["VIEW","CREATE"],
    USER:       ["VIEW"],
  },
  VIEWER: {
    WORKSPACE:  ["VIEW"],
    AGENT:      ["VIEW"],
    CHANNEL:    ["VIEW"],
    TOOL:       ["VIEW"],
    SKILL:      ["VIEW"],
    SECRET:     [],
    LOG:        ["VIEW"],
    USAGE:      ["VIEW"],
    SECURITY:   ["VIEW"],
    REVIEW:     ["VIEW"],
    GATEWAY:    ["VIEW"],
    TEMPLATE:   ["VIEW"],
    ALERT:      ["VIEW"],
    WHITELABEL: [],
    API_KEY:    [],
    USER:       [],
  },
};

export function can(
  role:     UserRole,
  resource: PermissionResource,
  action:   PermissionAction
): boolean {
  const actions = PERMISSION_MATRIX[role]?.[resource] ?? [];
  return actions.includes(action);
}

// ── Express middleware factory ────────────────────────────────
import { Request, Response, NextFunction } from "express";
import { AuthRequest } from "@/middleware/auth";

export function requirePermission(resource: PermissionResource, action: PermissionAction) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    const role = (req.userRole as UserRole) ?? "VIEWER";
    if (!can(role, resource, action)) {
      return res.status(403).json({
        error: `Permission denied: ${role} cannot ${action} ${resource}`,
      });
    }
    next();
  };
}
