import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  Object.defineProperty(globalThis, "AsyncLocalStorage", {
    value: AsyncLocalStorage,
    configurable: true,
  });
});
import { NextRequest } from "next/server";
import { proxy, config } from "../src/proxy";
import { unstable_doesMiddlewareMatch as unstable_doesProxyMatch } from "next/experimental/testing/server";

beforeEach(() => {
  vi.stubEnv("DATABASE_URL", "postgresql://unused.test/library");
  vi.stubEnv("NEON_AUTH_BASE_URL", "https://auth.example.test/auth");
  vi.stubEnv(
    "NEON_AUTH_COOKIE_SECRET",
    "test-only-cookie-secret-with-at-least-32-characters",
  );
  vi.stubEnv("LIBRARY_OWNER_EMAIL", "owner@example.test");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// Keep the actual Neon middleware: setting the login URL to the callback path
// must fail this test, because the SDK skips verification on its login page.
it.each([
  "/",
  "/?view=pdf",
  "/?view=pdf&panel=operations",
  "/connect/mcp?state=chatgpt-state",
])(
  "exchanges the Google callback on %s and preserves its return parameters",
  async (path) => {
    expect(
      unstable_doesProxyMatch({
        config,
        url: "https://library.example.test" + path,
      }),
    ).toBe(true);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (
        url.origin !== "https://auth.example.test" ||
        url.pathname !== "/auth/get-session" ||
        url.searchParams.get("neon_auth_session_verifier") !== "test-verifier"
      )
        throw new Error("Unexpected auth exchange request");
      return Response.json(
        {
          session: {
            id: "test-session-id",
            userId: "owner-id",
            token: "test-session",
            expiresAt: "2099-01-01T00:00:00.000Z",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          user: {
            id: "owner-id",
            email: "owner@example.test",
            emailVerified: true,
            name: "Owner",
            image: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
        {
          headers: {
            "set-cookie":
              "__Secure-neon-auth.session_token=test-session; Path=/; HttpOnly; Secure; SameSite=Lax",
          },
        },
      );
    });
    const response = await proxy(
      new NextRequest(
        "https://library.example.test" +
          path +
          (path.includes("?") ? "&" : "?") +
          "neon_auth_session_verifier=test-verifier",
        {
          headers: {
            cookie: "__Secure-neon-auth.session_challenge=test-challenge",
          },
        },
      ),
    );
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://library.example.test" + path,
    );
    expect(
      response.headers
        .getSetCookie()
        .some((c) => c.startsWith("__Secure-neon-auth.session_token=")),
    ).toBe(true);
  },
);
it("lets the consent page present its own Google sign-in while preserving the OAuth request", async () => {
  const response = await proxy(
    new NextRequest(
      "https://library.example.test/connect/mcp?state=chatgpt-state",
    ),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("x-middleware-next")).toBe("1");
});

it("opens the public device shell without an auth round trip; data and session APIs authenticate separately", async () => {
  const fetch = vi.fn(async () => {
    throw Error("The shell must not wait for remote authentication");
  });
  vi.stubGlobal("fetch", fetch);
  const response = await proxy(
    new NextRequest("https://library.example.test/"),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("x-middleware-next")).toBe("1");
  expect(response.headers.get("location")).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});
it("lets the PDF entry render its owner-checked sign-in without dropping the destination", async () => {
  const response = await proxy(
    new NextRequest("https://library.example.test/?view=pdf&panel=operations"),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("x-middleware-next")).toBe("1");
});
it("does not intercept removed PDF reader routes", () => {
  expect(
    unstable_doesProxyMatch({
      config,
      url: "https://library.example.test/reader/11111111-1111-4111-8111-111111111111",
    }),
  ).toBe(false);
});
