import { defineConfig, devices } from "@playwright/test";
const isolated = !!process.env.CI;
const authPort = process.env.PLAYWRIGHT_AUTH_PORT ?? "3001";
const appServer = {
  command: "npm run dev -- --hostname 127.0.0.1 --webpack",
  url: "http://127.0.0.1:3000",
  reuseExistingServer: !isolated,
  ...(isolated && {
    // Public, test-only values. CI must never receive the personal DB or keys.
    // The real auth middleware/owner checks run against an anonymous provider.
    env: {
      DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused",
      NEON_AUTH_BASE_URL: `http://127.0.0.1:${authPort}`,
      NEON_AUTH_COOKIE_SECRET:
        "test-only-anonymous-cookie-secret-never-use-in-production",
      LIBRARY_OWNER_EMAIL: "owner@example.invalid",
      APP_ORIGIN: "http://127.0.0.1:3000",
    },
  }),
};
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  use: { baseURL: "http://127.0.0.1:3000", ...devices["Desktop Chrome"] },
  webServer: isolated
    ? [
        {
          command: "node e2e/fixtures/anonymous-auth.mjs",
          url: `http://127.0.0.1:${authPort}/health`,
          reuseExistingServer: false,
        },
        appServer,
      ]
    : appServer,
  reporter: "list",
});
