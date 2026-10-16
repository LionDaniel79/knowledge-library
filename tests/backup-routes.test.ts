import { beforeAll, afterAll, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { LibraryError, createLibraryStore } from "../src/server/library-store";
let fixture: Awaited<ReturnType<typeof testDatabase>>,
  owner = "owner";
vi.mock("@/server/auth", () => ({
  requireOwner: async () => {
    if (!owner) throw new LibraryError(401, "로그인 필요");
    return owner;
  },
}));
vi.mock("@/server/db", () => ({
  database: {
    query: (s: string, p: unknown[]) => fixture.db.query(s, p),
    transaction: (fn: any) => fixture.db.transaction(fn),
  },
}));
import { GET, POST } from "../src/app/api/backup/route";
beforeAll(async () => {
  fixture = await testDatabase();
  vi.stubEnv("APP_ORIGIN", "https://library.test");
  await createLibraryStore(fixture.db).mutate(owner, {
    requestId: randomUUID(),
    type: "addBook",
    payload: { title: "비공개 책", formats: ["paper"] },
  });
});
afterAll(async () => {
  await fixture?.pg.close();
  vi.unstubAllEnvs();
});
const request = (body: unknown, origin = "https://library.test") =>
  new Request("https://library.test/api/backup", {
    method: "POST",
    headers: { origin },
    body: JSON.stringify(body),
  });
it("protects backup downloads and restore requests with owner authentication, origin and an explicit action", async () => {
  const download = await GET();
  expect(download.headers.get("cache-control")).toContain("no-store");
  const backup = await download.json();
  expect(backup.tables.library_books).toHaveLength(1);
  expect(
    (
      await POST(
        request({ action: "preview", backup }, "https://elsewhere.test"),
      )
    ).status,
  ).toBe(403);
  expect((await POST(request({ backup }))).status).toBe(400);
  expect(
    (await (await POST(request({ action: "preview", backup }))).json())
      .canRestore,
  ).toBe(false);
  expect((await POST(request({ action: "restore", backup }))).status).toBe(409);
  owner = "";
  expect((await GET()).status).toBe(401);
  expect((await POST(request({ action: "preview", backup }))).status).toBe(401);
  owner = "owner";
});
it("rejects oversized requests from headers and malformed JSON", async () => {
  expect(
    (
      await POST(
        new Request("https://library.test/api/backup", {
          method: "POST",
          headers: {
            origin: "https://library.test",
            "content-length": "999999999",
          },
          body: "{}",
        }),
      )
    ).status,
  ).toBe(413);
  expect(
    (
      await POST(
        new Request("https://library.test/api/backup", {
          method: "POST",
          headers: { origin: "https://library.test" },
          body: "{",
        }),
      )
    ).status,
  ).toBe(400);
});
it("allows large historical backups past 64 MB to reach format validation", async () => {
  // The real corpus has an 81 MiB backup because original imports and revisions are preserved.
  const response = await POST(
    request({
      action: "preview",
      backup: { archive: " ".repeat(65 * 1024 * 1024) },
    }),
  );
  expect(response.status).toBe(400);
});
