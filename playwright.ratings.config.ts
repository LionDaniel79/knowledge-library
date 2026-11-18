import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  testMatch: "reading-ratings.spec.ts",
  use: { browserName: "chromium", headless: true },
  reporter: "list",
  workers: 1,
});
