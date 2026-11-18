import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  testMatch: ["book-note-title.spec.ts", "reading-ratings.spec.ts"],
  use: { browserName: "chromium", headless: true },
  reporter: "list",
  workers: 1,
});
