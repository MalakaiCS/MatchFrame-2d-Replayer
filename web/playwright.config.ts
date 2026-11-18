import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 180_000,
  expect: { timeout: 10_000 },
  workers: 1,
  reporter: [["list"]],
  use: {
    trace: "off",
    actionTimeout: 10_000,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    // Set PW_CHROMIUM_PATH to use a preinstalled Chromium instead of `npx playwright install`.
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
});
