import type { Config } from "jest";
const config: Config = {
  preset: "ts-jest",
  testEnvironment: "node",
  moduleNameMapper: { "@/(.*)": "<rootDir>/src/$1" },
  testMatch: ["**/tests/**/*.test.ts"],
  setupFilesAfterFramework: ["<rootDir>/tests/setup.ts"],
  globalSetup:    "<rootDir>/tests/global-setup.ts",
  globalTeardown: "<rootDir>/tests/global-teardown.ts",
  coverageDirectory: "coverage",
  collectCoverageFrom: ["src/**/*.ts", "!src/index.ts"],
};
export default config;
