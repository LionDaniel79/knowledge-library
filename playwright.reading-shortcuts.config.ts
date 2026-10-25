import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "e2e",
  testMatch: [
    "reading-shortcuts-search.spec.ts",
    "search-tabs-relations.spec.ts",
    "book-catalog.spec.ts",
    "unified-notes.spec.ts",
  ],
  workers: 1,
  reporter: "list",
  outputDir: "test-results/reading-shortcuts",
  use: {
    ...devices["Desktop Chrome"],
    channel: "chrome",
    headless: true,
    viewport: { width: 1280, height: 900 },
  },
});
