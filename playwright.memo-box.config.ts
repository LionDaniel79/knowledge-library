import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "e2e",
  testMatch: [
    "memo-box.spec.ts",
    "topic-material-kind.spec.ts",
    "thought-map-usability-oct21.spec.ts",
  ],
  workers: 1,
  fullyParallel: false,
  reporter: "list",
  outputDir: "test-results/memo-box",
  use: {
    ...devices["Desktop Chrome"],
    channel: "chrome",
    headless: true,
    viewport: { width: 1280, height: 900 },
  },
});
