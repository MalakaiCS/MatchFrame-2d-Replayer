import { defineConfig } from "vitest/config";
import path from "node:path";

// Unit tests always run. API integration tests run when MF_BASE_URL points at a live server + worker.
const api = !!process.env.MF_BASE_URL;

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    include: api ? ["tests/api/**/*.test.ts"] : ["src/**/*.test.ts", "tests/unit/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
