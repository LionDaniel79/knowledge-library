import { defineConfig, devices } from "@playwright/test";

// Self-contained fixtures; never starts or resets the user's private PC server.
export default defineConfig({
  testDir: "e2e",
  testMatch: [
    "pdf-search-phrases.spec.ts",
    "replica-pdf-entry.spec.ts",
    "thought-bundle-delete.spec.ts",
    "shared-thought-workflow.spec.ts",
    "whiteboard.spec.ts",
  ],
  workers: 1,
  reporter: "list",
  outputDir: "test-results/library-maintenance",
  use: { ...devices["Desktop Chrome"], channel: "chrome", headless: true },
});
