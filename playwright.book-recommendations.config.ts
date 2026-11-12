import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "e2e",
  testMatch: "book-recommendations.spec.ts",
  workers: 1,
  reporter: "list",
  outputDir: "test-results/book-recommendations",
  use: { ...devices["Desktop Chrome"], channel: "chrome", headless: true },
});
