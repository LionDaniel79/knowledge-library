import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "e2e",
  testMatch: ["search-tabs-relations.spec.ts", "book-catalog.spec.ts"],
  workers: 1,
  reporter: "list",
  outputDir: "test-results/search-tabs",
  use: {
    ...devices["Desktop Chrome"],
    channel: "chrome",
    headless: true,
    viewport: { width: 1280, height: 900 },
  },
});
