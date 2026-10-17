import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { LibraryError } from "../src/server/library-store";
const state = vi.hoisted(() => ({
  authenticated: true,
  found: true,
  query: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw Error(`REDIRECT:${url}`);
  }),
}));
vi.mock("@/server/auth", () => ({
  configured: () => true,
  requireOwner: async () => {
    if (!state.authenticated) throw new LibraryError(401, "Sign in required");
    return "owner";
  },
}));
vi.mock("@/server/db", () => ({
  database: {
    query: async (...args: unknown[]) => {
      state.query(...args);
      return { rows: state.found ? [{ title: "내 PDF" }] : [] };
    },
  },
}));
vi.mock("@/components/pdf-reader", () => ({ PdfReader: () => null }));
vi.mock("@/components/auth-panel", () => ({ AuthPanel: () => null }));
vi.mock("next/navigation", () => ({ redirect: state.redirect }));
import Reader from "../src/app/reader/[id]/page";
const id = "11111111-1111-4111-8111-111111111111",
  pc = "https://library.example.ts.net";
const read = (query: { page?: string; signature?: string } = {}) =>
  Reader({
    params: Promise.resolve({ id }),
    searchParams: Promise.resolve(query),
  });
beforeEach(() => {
  state.authenticated = true;
  state.found = true;
  vi.clearAllMocks();
  vi.stubEnv("LIBRARY_PDF_ROOT", "");
  vi.stubEnv("LIBRARY_PYTHON", "");
  vi.stubEnv("LIBRARY_PC_PRIVATE_CONFIRMED", "true");
  vi.stubEnv("LIBRARY_PC_ORIGIN", pc);
  vi.stubEnv("APP_ORIGIN", "https://library.test");
});
afterEach(() => vi.unstubAllEnvs());
it("retains the original PDF page when the private browser needs its own login", async () => {
  state.authenticated = false;
  const page = await read({ page: "42", signature: "abc:123" });
  expect(page.props.returnPath).toBe(
    `/reader/${id}?page=42&signature=abc%3A123`,
  );
  expect(state.query).not.toHaveBeenCalled();
});
it("opens the owned PDF on the confirmed private PC in one navigation, preserving citation page/signature", async () => {
  await expect(read({ page: "42", signature: "abc:123" })).rejects.toThrow(
    `REDIRECT:${pc}/reader/${id}?page=42&signature=abc%3A123`,
  );
  expect(state.query).toHaveBeenCalledWith(expect.any(String), ["owner", id]);
});
it("renders locally after root relocation and never redirects the PC to itself", async () => {
  vi.stubEnv("APP_ORIGIN", pc);
  vi.stubEnv("LIBRARY_PDF_ROOT", "/old-root-no-longer-present");
  vi.stubEnv("LIBRARY_PYTHON", process.execPath);
  const page = await read();
  expect((page.props as any).localAvailable).toBe(true);
  expect(state.redirect).not.toHaveBeenCalled();
  vi.stubEnv("LIBRARY_PYTHON", "");
  await read();
  expect(state.redirect).not.toHaveBeenCalled();
});
it("does not redirect unauthenticated, unknown, unconfirmed or invalid-destination requests", async () => {
  state.authenticated = false;
  await read();
  expect(state.query).not.toHaveBeenCalled();
  state.authenticated = true;
  state.found = false;
  await read();
  state.found = true;
  vi.stubEnv("LIBRARY_PC_PRIVATE_CONFIRMED", "false");
  await read();
  vi.stubEnv("LIBRARY_PC_PRIVATE_CONFIRMED", "true");
  vi.stubEnv("LIBRARY_PC_ORIGIN", "https://evil.example");
  await read();
  expect(state.redirect).not.toHaveBeenCalled();
});
