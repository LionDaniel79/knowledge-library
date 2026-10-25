import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "e2e",
  testMatch: ["unified-notes.spec.ts", "assist.spec.ts"],
  workers: 1,
  reporter: "list",
  outputDir: "test-results/unified-notes",
  use: {
    ...devices["Desktop Chrome"],
    channel: "chrome",
    headless: true,
    viewport: { width: 1280, height: 900 },
  },
});
