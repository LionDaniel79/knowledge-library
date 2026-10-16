import { beforeAll, afterAll, it, expect, vi } from "vitest";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { createLibraryStore } from "../src/server/library-store";
let f: Awaited<ReturnType<typeof testDatabase>>;
vi.mock("@/server/auth", () => ({ requireOwner: async () => "me" }));
vi.mock("@/server/db", () => ({
  database: {
    query: (s: string, p: unknown[]) => f.db.query(s, p),
    transaction: (fn: any) => f.db.transaction(fn),
  },
  getStore: () => createLibraryStore(f.db),
}));
import { POST } from "../src/app/api/library/route";
beforeAll(async () => {
  f = await testDatabase();
  vi.stubEnv("APP_ORIGIN", "https://library.test");
});
afterAll(async () => {
  await f.pg.close();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
const request = (payload: unknown) =>
  new Request("https://library.test/api/library", {
    method: "POST",
    headers: { origin: "https://library.test" },
    body: JSON.stringify(payload),
  });
it("downloads a changed cover through the actual edit request while an unchanged offline cover does not block other edits", async () => {
  const library = createLibraryStore(f.db),
    old = "https://offline.invalid/old.jpg";
  const { id } = await library.mutate("me", {
    type: "addBook",
    requestId: randomUUID(),
    payload: { title: "책", coverUrl: old, formats: ["paper"] },
  });
  vi.stubGlobal("fetch", async () => {
    throw Error("offline");
  });
  const first = await POST(
    request({
      type: "editBook",
      requestId: randomUUID(),
      payload: {
        id,
        expectedVersion: 1,
        title: "제목 수정",
        coverUrl: old,
        formats: ["paper"],
      },
    }),
  );
  expect(first.status).toBe(200);
  const png = await sharp({
    create: { width: 40, height: 60, channels: 3, background: "green" },
  })
    .png()
    .toBuffer();
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(new Uint8Array(png), {
        headers: { "content-type": "image/png" },
      }),
  );
  const second = await POST(
    request({
      type: "editBook",
      requestId: randomUUID(),
      payload: {
        id,
        expectedVersion: 2,
        title: "제목 수정",
        coverUrl: "https://image.yes24.com/new.jpg",
        formats: ["paper"],
      },
    }),
  );
  expect(second.status).toBe(200);
  const saved = (await library.snapshot("me")).books[0];
  expect(saved.coverUrl).toBe("https://image.yes24.com/new.jpg");
  expect(saved.storedCoverUrl).toMatch(/^\/api\/book-covers\/[a-f0-9-]{36}$/);
  expect(
    (await f.db.query("SELECT * FROM library_cover_assets WHERE owner_id='me'"))
      .rows,
  ).toHaveLength(1);
});
