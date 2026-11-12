import { afterEach, expect, it, vi } from "vitest";
import { LibraryError } from "../src/server/library-store";
const state = vi.hoisted(() => ({
  owner: "fixture",
  read: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@/server/auth", () => ({
  requireOwner: async () => {
    if (!state.owner) throw new LibraryError(401, "로그인이 필요합니다.");
    return state.owner;
  },
}));
vi.mock("@/server/db", () => ({ database: {} }));
vi.mock("@/server/book-recommendations", () => ({
  createBookRecommendationStore: () => ({
    read: state.read,
    refresh: state.refresh,
  }),
}));
import {
  GET,
  POST,
  maxDuration,
} from "../src/app/api/book-recommendations/route";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  state.owner = "fixture";
});
it("requires authenticated ownership, same origin, and private uncacheable bounded responses", async () => {
  vi.stubEnv("APP_ORIGIN", "https://library.test");
  state.read.mockResolvedValue({
    recommendations: [],
    books: [],
    updatedAt: null,
    request: null,
  });
  state.refresh.mockResolvedValue({
    recommendations: [],
    books: [],
    updatedAt: null,
    request: null,
  });
  expect(maxDuration).toBe(300);
  state.owner = "";
  expect((await GET()).status).toBe(401);
  expect(
    (
      await POST(
        new Request("https://library.test/api/book-recommendations", {
          method: "POST",
          headers: { origin: "https://library.test" },
          body: "{}",
        }),
      )
    ).status,
  ).toBe(401);
  state.owner = "fixture";
  expect(
    (
      await POST(
        new Request("https://library.test/api/book-recommendations", {
          method: "POST",
          headers: { origin: "https://other.test" },
          body: "{}",
        }),
      )
    ).status,
  ).toBe(403);
  const response = await GET();
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(state.read).toHaveBeenCalledWith("fixture");
  const result = await POST(
    new Request("https://library.test/api/book-recommendations", {
      method: "POST",
      headers: { origin: "https://library.test" },
      body: '{"requestId":"test"}',
    }),
  );
  expect(result.headers.get("cache-control")).toBe("private, no-store");
  expect(state.refresh).toHaveBeenCalledWith("fixture", { requestId: "test" });
});
