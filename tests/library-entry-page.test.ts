import { afterEach, beforeEach, it, expect, vi } from "vitest";
import { LibraryError } from "../src/server/library-store";
const state = vi.hoisted(() => ({ authenticated: true, reads: 0 }));
vi.mock("@/server/auth", () => ({
  configured: () => true,
  requireOwner: async () => {
    if (!state.authenticated) throw new LibraryError(401, "Sign in required");
    return "owner";
  },
}));
vi.mock("@/server/db", () => ({
  getStore: () => ({
    overview: async () => {
      state.reads++;
      return { books: [], notes: [], cycles: [] };
    },
  }),
}));
vi.mock("@/components/library-app", () => ({ LibraryApp: () => null }));
vi.mock("@/components/auth-panel", () => ({ AuthPanel: () => null }));
import Page from "../src/app/page";
beforeEach(() => {
  state.authenticated = true;
  state.reads = 0;
});
afterEach(() => vi.unstubAllEnvs());
const open = (query: Record<string, string | string[] | undefined>) =>
  Page({ searchParams: Promise.resolve(query) });
it("retires the PDF search/processing entry and opens the normal metadata library shell", async () => {
  const pdf = await open({ view: "pdf" });
  expect(pdf.props.initialView).toBeUndefined();
  const operations = await open({ view: "pdf", panel: "operations" });
  expect(operations.props.initialOperationsOpen).toBeUndefined();
  const home = await open({ view: ["pdf", "home"] });
  expect(home.props.initialView).toBeUndefined();
});
it("does not restore a retired PC PDF sign-in destination or read private book data", async () => {
  state.authenticated = false;
  const page = await open({ view: "pdf", panel: "operations" });
  expect(page.props.returnPath).toBeUndefined();
  expect(state.reads).toBe(0);
});
it("ignores old private PC connection configuration when opening the web shell", async () => {
  vi.stubEnv("LIBRARY_PC_ORIGIN", "https://library.example.ts.net");
  vi.stubEnv("LIBRARY_PC_PRIVATE_CONFIRMED", "true");
  vi.stubEnv("APP_ORIGIN", "https://library.example.ts.net");
  expect((await open({ view: "pdf" })).props.deferPdfAutoSync).toBeUndefined();
  expect((await open({})).props.deferPdfAutoSync).toBeUndefined();
  vi.stubEnv("APP_ORIGIN", "https://public-library.test");
  expect((await open({ view: "pdf" })).props.deferPdfAutoSync).toBeUndefined();
  vi.stubEnv("APP_ORIGIN", "https://library.example.ts.net");
  vi.stubEnv("LIBRARY_PC_PRIVATE_CONFIRMED", "false");
  expect((await open({ view: "pdf" })).props.deferPdfAutoSync).toBeUndefined();
});
