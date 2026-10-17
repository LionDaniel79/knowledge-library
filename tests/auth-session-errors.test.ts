import { expect, it, vi, beforeEach, afterEach } from "vitest";
const session = vi.hoisted(() => vi.fn());
vi.mock("@neondatabase/auth/next/server", () => ({
  createNeonAuth: () => ({ getSession: session }),
}));
import { requireOwner } from "../src/server/auth";
beforeEach(() => {
  vi.stubEnv("DATABASE_URL", "postgresql://unused.test/library");
  vi.stubEnv("NEON_AUTH_BASE_URL", "https://auth.test/auth");
  vi.stubEnv(
    "NEON_AUTH_COOKIE_SECRET",
    "fixture-secret-at-least-thirty-two-characters",
  );
  vi.stubEnv("LIBRARY_OWNER_EMAIL", "owner@test.invalid");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
it.each([
  [429, 429],
  [502, 503],
])(
  "preserves upstream authentication failure %i as a recoverable %i instead of reporting logout",
  async (upstream, status) => {
    session.mockResolvedValue({
      data: null,
      error: { status: upstream, message: "private-provider-detail" },
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(requireOwner()).rejects.toMatchObject({ status });
    await expect(requireOwner()).rejects.not.toThrow("private-provider-detail");
  },
);
it("still requires login for a genuinely missing session", async () => {
  session.mockResolvedValue({ data: null, error: null });
  await expect(requireOwner()).rejects.toMatchObject({ status: 401 });
});
