// tests/integration/api.auth.test.ts
// Integration tests using supertest against the actual Express app
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import request from "supertest";
import { server } from "@/index";
import { prisma } from "@/db/client";
import bcrypt from "bcryptjs";

let authToken = "";
let testUserId = "";

describe("Auth API", () => {
  beforeAll(async () => {
    // Create test user
    const hash = await bcrypt.hash("testpass123", 10);
    const user = await prisma.user.upsert({
      where:  { email: "test@openclaw.dev" },
      update: { passwordHash: hash },
      create: { email: "test@openclaw.dev", passwordHash: hash, name: "Test User", role: "ADMIN" },
    });
    testUserId = user.id;
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: testUserId } }).catch(() => {});
    server.close();
  });

  describe("POST /api/auth/login", () => {
    it("returns token for valid credentials", async () => {
      const res = await request(server)
        .post("/api/auth/login")
        .send({ email: "test@openclaw.dev", password: "testpass123" });

      expect(res.status).toBe(200);
      expect(res.body.token).toBeTruthy();
      expect(res.body.user.email).toBe("test@openclaw.dev");
      authToken = res.body.token;
    });

    it("returns 401 for wrong password", async () => {
      const res = await request(server)
        .post("/api/auth/login")
        .send({ email: "test@openclaw.dev", password: "wrongpassword" });
      expect(res.status).toBe(401);
    });

    it("returns 400 for invalid email format", async () => {
      const res = await request(server)
        .post("/api/auth/login")
        .send({ email: "not-an-email", password: "pass123" });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/auth/me", () => {
    it("returns user info with valid token", async () => {
      const res = await request(server)
        .get("/api/auth/me")
        .set("Authorization", `Bearer ${authToken}`);
      expect(res.status).toBe(200);
      expect(res.body.email).toBe("test@openclaw.dev");
    });

    it("returns 401 without token", async () => {
      const res = await request(server).get("/api/auth/me");
      expect(res.status).toBe(401);
    });

    it("returns 401 with invalid token", async () => {
      const res = await request(server)
        .get("/api/auth/me")
        .set("Authorization", "Bearer invalid.token.here");
      expect(res.status).toBe(401);
    });
  });
});

describe("Workspaces API", () => {
  let wsId = "";

  it("POST /api/workspaces — creates workspace", async () => {
    const res = await request(server)
      .post("/api/workspaces")
      .set("Authorization", `Bearer ${authToken}`)
      .send({ name: "Test WS", client: "Test Client", plan: "STARTER" });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe("Test WS");
    wsId = res.body.id;
  });

  it("GET /api/workspaces — lists workspaces", async () => {
    const res = await request(server)
      .get("/api/workspaces")
      .set("Authorization", `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some((w: { id: string }) => w.id === wsId)).toBe(true);
  });

  it("PATCH /api/workspaces/:id — updates workspace", async () => {
    const res = await request(server)
      .patch(`/api/workspaces/${wsId}`)
      .set("Authorization", `Bearer ${authToken}`)
      .send({ name: "Updated WS" });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Updated WS");
  });

  it("DELETE /api/workspaces/:id — deletes workspace", async () => {
    const res = await request(server)
      .delete(`/api/workspaces/${wsId}`)
      .set("Authorization", `Bearer ${authToken}`);
    expect(res.status).toBe(204);
  });
});
