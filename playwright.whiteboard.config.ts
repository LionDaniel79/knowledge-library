import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "e2e",
  testMatch: "whiteboard.spec.ts",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  outputDir:
    "E:/지식서재 작업/private-data/runtime/whiteboard-browser-results-20261023",
  use: {
    ...devices["Desktop Chrome"],
    channel: "chrome",
    headless: true,
    viewport: { width: 1280, height: 900 },
  },
});
