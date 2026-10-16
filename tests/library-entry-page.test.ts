import { beforeEach, it, expect, vi } from "vitest";
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
const open = (query: Record<string, string | string[] | undefined>) =>
  Page({ searchParams: Promise.resolve(query) });
it("opens PDF search and its processing panel from a direct link rather than the home view", async () => {
  const pdf = await open({ view: "pdf" });
  expect(pdf.props.initialView).toBe("pdf");
  const operations = await open({ view: "pdf", panel: "operations" });
  expect(operations.props.initialOperationsOpen).toBe(true);
  const home = await open({ view: ["pdf", "home"] });
  expect(home.props.initialView).toBe("home");
});
it("keeps the PDF destination when sign-in is needed without reading private book data", async () => {
  state.authenticated = false;
  const page = await open({ view: "pdf", panel: "operations" });
  expect(page.props.returnPath).toBe("/?view=pdf&panel=operations");
  expect(state.reads).toBe(0);
});
