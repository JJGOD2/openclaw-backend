// tests/setup.ts
// 每個 test 前後清理，使用測試專用 DB
import { prisma } from "@/db/client";

beforeEach(async () => {
  // Reset sequences / clear test data between tests
});

afterAll(async () => {
  await prisma.$disconnect();
});
