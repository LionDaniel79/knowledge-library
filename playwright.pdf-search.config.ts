import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "e2e",
  testMatch: "pdf-search-phrases.spec.ts",
  workers: 1,
  reporter: "list",
  outputDir: "test-results/pdf-search-phrases",
  use: {
    ...devices["Desktop Chrome"],
    channel: "chrome",
    headless: true,
    viewport: { width: 1280, height: 900 },
  },
});
