import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "e2e",
  testMatch: "whiteboard.spec.ts",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  outputDir: "test-results/whiteboard",
  use: {
    ...devices["Desktop Chrome"],
    channel: "chrome",
    headless: true,
    viewport: { width: 1280, height: 900 },
  },
});
