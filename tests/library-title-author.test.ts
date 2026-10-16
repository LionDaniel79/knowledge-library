import { afterEach, expect, it, vi } from "vitest";
vi.mock("../src/local/curation/api-quota", () => ({
  reserveCatalogRequest: vi.fn(),
}));
import { lookupLibraryTitle } from "../src/server/catalog-provider";
afterEach(() => vi.unstubAllGlobals());
it("sends title AND author to the library provider without changing title-only callers", async () => {
  const fetcher = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ response: { numFound: 0, docs: [] } }),
  });
  vi.stubGlobal("fetch", fetcher);
  await lookupLibraryTitle("마음의 이해 (2)", "test-key", "홍길동");
  const first = new URL(String(fetcher.mock.calls[0][0]));
  expect(first.searchParams.get("title")).toBe("마음의 이해 2");
  expect(first.searchParams.get("author")).toBe("홍길동");
  await lookupLibraryTitle("마음의 이해", "test-key");
  expect(
    new URL(String(fetcher.mock.calls[1][0])).searchParams.has("author"),
  ).toBe(false);
});
