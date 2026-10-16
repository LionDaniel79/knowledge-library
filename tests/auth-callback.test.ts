import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "../src/proxy";

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
it("exchanges the Google callback before rendering and removes its verifier", async () => {
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
      "https://library.example.test/?neon_auth_session_verifier=test-verifier",
      {
        headers: {
          cookie: "__Secure-neon-auth.session_challenge=test-challenge",
        },
      },
    ),
  );
  expect(response.status).toBe(307);
  expect(response.headers.get("location")).toBe(
    "https://library.example.test/",
  );
  expect(
    response.headers
      .getSetCookie()
      .some((c) => c.startsWith("__Secure-neon-auth.session_token=")),
  ).toBe(true);
});

it("sends an anonymous visitor to a separate accessible sign-in page", async () => {
  const response = await proxy(
    new NextRequest("https://library.example.test/"),
  );
  expect(response.status).toBe(307);
  expect(response.headers.get("location")).toBe(
    "https://library.example.test/auth/sign-in",
  );
});
