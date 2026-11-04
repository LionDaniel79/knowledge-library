import { it, expect, vi } from "vitest";
const query = vi.hoisted(() =>
  vi.fn(() => {
    throw Error("retired endpoints must not read the database");
  }),
);
vi.mock("@/server/db", () => ({ database: { query } }));
vi.mock("@/server/auth", () => ({
  requireOwner: async () => {
    throw Error("retired endpoint must not start login");
  },
}));
import { GET } from "../src/app/api/pdf/route";
import { POST } from "../src/app/api/pdf/import/route";
it("retires legacy original search and import without DB, filesystem, PC redirect or login", async () => {
  for (const response of [
    await GET(
      new Request("https://library.invalid/api/pdf?mode=search&q=private"),
    ),
    await POST(
      new Request("https://library.invalid/api/pdf/import", {
        method: "POST",
        body: "invalid json",
      }),
    ),
  ]) {
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({
      code: "desktop_pdf_required",
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
  expect(query).not.toHaveBeenCalled();
});
