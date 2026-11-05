import { it, expect, vi } from "vitest";
const db = vi.hoisted(() =>
  vi.fn(() => {
    throw Error("Retired reader must not query DB");
  }),
);
const redirect = vi.hoisted(() =>
  vi.fn(() => {
    throw Error("Retired reader must not call PC");
  }),
);
vi.mock("@/server/db", () => ({ database: { query: db } }));
vi.mock("next/navigation", () => ({ redirect }));
import Reader from "../src/app/reader/[id]/page";
it("replaces a legacy bookmark with a static desktop-reader notice without DB or Tailscale dependency", async () => {
  const page = await Reader({
    params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }),
    searchParams: Promise.resolve({
      page: "42",
      signature: "private-signature",
    }),
  });
  const text = JSON.stringify(page);
  expect(text).toContain("Windows PDF");
  expect(text).not.toContain("private-signature");
  expect(db).not.toHaveBeenCalled();
  expect(redirect).not.toHaveBeenCalled();
});
