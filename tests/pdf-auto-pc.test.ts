import { afterEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ owner: "owner" }));
vi.mock("@/server/auth", () => ({
  requireOwner: async () => {
    if (!state.owner)
      throw Object.assign(new Error("로그인 필요"), { status: 401 });
    return state.owner;
  },
}));
vi.mock("@/server/db", () => ({ database: { query: vi.fn() } }));
vi.mock("@/server/pdf-index", () => ({
  searchPdfPages: () => {
    throw Error("Missing local index");
  },
  withPdfIndex: vi.fn(),
  pdfDocumentDetail: vi.fn(),
}));
import { GET } from "../src/app/api/pdf/route";
afterEach(() => {
  vi.unstubAllEnvs();
  state.owner = "owner";
});
it("lets an authenticated online search continue in the private PC without a cross-origin server redirect", async () => {
  vi.stubEnv("LIBRARY_PDF_INDEX", "");
  vi.stubEnv("LIBRARY_PC_ORIGIN", "https://library.example.ts.net");
  vi.stubEnv("LIBRARY_PC_PRIVATE_CONFIRMED", "true");
  const response = await GET(
    new Request(
      "https://library.test/api/pdf?mode=search&q=%EC%9D%80%ED%98%9C",
    ),
  );
  expect(response.status).toBe(200);
  const data = await response.json();
  const url = new URL(data.pcRedirect);
  expect(url.origin).toBe("https://library.example.ts.net");
  expect(url.searchParams.get("pdfQuery")).toBe("은혜");
  state.owner = "";
  expect(
    (await GET(new Request("https://library.test/api/pdf?mode=search&q=test")))
      .status,
  ).toBeGreaterThanOrEqual(400);
});
it("never creates a redirect loop or sends a search to an unconfirmed host", async () => {
  vi.stubEnv("LIBRARY_PDF_INDEX", "");
  vi.stubEnv("LIBRARY_PC_ORIGIN", "https://library.example.ts.net");
  vi.stubEnv("LIBRARY_PC_PRIVATE_CONFIRMED", "true");
  expect(
    (
      await GET(
        new Request(
          "https://library.example.ts.net/api/pdf?mode=search&q=test",
        ),
      )
    ).status,
  ).toBeGreaterThanOrEqual(400);
  vi.stubEnv("LIBRARY_PC_PRIVATE_CONFIRMED", "false");
  const r = await GET(
    new Request("https://library.test/api/pdf?mode=search&q=test"),
  );
  expect(r.status).toBeGreaterThanOrEqual(400);
});
it("does not route a private server back to itself when its reverse proxy uses a loopback URL", async () => {
  vi.stubEnv("LIBRARY_PDF_INDEX", "");
  vi.stubEnv("LIBRARY_PC_ORIGIN", "https://library.example.ts.net");
  vi.stubEnv("LIBRARY_PC_PRIVATE_CONFIRMED", "true");
  vi.stubEnv("APP_ORIGIN", "https://library.example.ts.net");
  expect(
    (await GET(new Request("http://127.0.0.1:3001/api/pdf?mode=search&q=test")))
      .status,
  ).toBeGreaterThanOrEqual(400);
});
it.each(['"상담 관계', "상담 ".repeat(70)])(
  "rejects invalid or overlong fulltext input without truncating or redirecting it: %s",
  async (query) => {
    vi.stubEnv("LIBRARY_PDF_INDEX", "");
    vi.stubEnv("LIBRARY_PC_ORIGIN", "https://library.example.ts.net");
    vi.stubEnv("LIBRARY_PC_PRIVATE_CONFIRMED", "true");
    const response = await GET(
      new Request(
        "https://library.test/api/pdf?mode=search&q=" +
          encodeURIComponent(query),
      ),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.any(String) });
  },
);
