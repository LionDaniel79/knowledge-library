import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { testDatabase } from "./helpers/database";
import { createLibraryStore } from "../src/server/library-store";
let f: Awaited<ReturnType<typeof testDatabase>>;
const auth = vi.hoisted(() => ({ owner: "cover-owner" }));
vi.mock("@/server/auth", () => ({ requireOwner: async () => auth.owner }));
vi.mock("@/server/db", () => ({
  database: {
    query: (s: string, p: unknown[]) => f.db.query(s, p),
    transaction: (fn: any) => f.db.transaction(fn),
  },
}));
import { GET } from "../src/app/api/books/[id]/cover/route";

beforeAll(async () => {
  f = await testDatabase();
});
afterAll(async () => {
  await f.pg.close();
  vi.unstubAllGlobals();
});
it("recovers an owned book's missing stored cover, reuses it and revalidates without sending bytes", async () => {
  const store = createLibraryStore(f.db),
    source = "https://image.yes24.com/goods/123/L";
  const { id } = await store.mutate(auth.owner, {
    type: "addBook",
    requestId: randomUUID(),
    payload: { title: "표지 복구", coverUrl: source, formats: ["paper"] },
  });
  const before = (
    await f.db.query(
      "SELECT * FROM library_books WHERE owner_id=$1 AND id=$2",
      [auth.owner, id],
    )
  ).rows;
  const bytes = await sharp({
    create: { width: 80, height: 120, channels: 3, background: "green" },
  })
    .png()
    .toBuffer();
  let downloads = 0;
  vi.stubGlobal("fetch", async (url: URL) => {
    expect(String(url)).toBe(source);
    downloads++;
    return new Response(new Uint8Array(bytes), {
      headers: { "Content-Type": "image/png" },
    });
  });
  const context = { params: Promise.resolve({ id: id! }) },
    request = (etag?: string) =>
      new Request("https://library.test/api/books/" + id + "/cover", {
        headers: etag ? { "If-None-Match": etag } : {},
      });
  const first = await GET(request(), context);
  expect(first.status).toBe(200);
  expect(first.headers.get("content-type")).toBe("image/webp");
  expect(first.headers.get("cache-control")).toContain("private");
  const savedImage = Buffer.from(await first.arrayBuffer());
  expect((await sharp(savedImage).metadata()).width).toBe(80);
  const second = await GET(request(first.headers.get("etag")!), context);
  expect(second.status).toBe(304);
  expect((await second.arrayBuffer()).byteLength).toBe(0);
  expect(downloads).toBe(1);
  const after = (
    await f.db.query(
      "SELECT * FROM library_books WHERE owner_id=$1 AND id=$2",
      [auth.owner, id],
    )
  ).rows;
  expect(after).toEqual(before);
  const book = (await store.snapshot(auth.owner)).books[0];
  expect(book.storedCoverUrl).toMatch(/^\/api\/book-covers\/[a-f0-9-]{36}$/);
  expect(
    (
      await f.db.query(
        "SELECT count(*)::int n FROM library_cover_assets WHERE owner_id=$1",
        [auth.owner],
      )
    ).rows[0].n,
  ).toBe(1);
  auth.owner = "other-owner";
  expect((await GET(request(), context)).status).toBe(404);
  expect(downloads).toBe(1);
  auth.owner = "";
  expect((await GET(request(), context)).status).toBe(401);
  auth.owner = "cover-owner";
});

it("rejects unsafe saved addresses before any network request", async () => {
  const { id } = await createLibraryStore(f.db).mutate(auth.owner, {
    type: "addBook",
    requestId: randomUUID(),
    payload: {
      title: "주소 검증",
      formats: ["paper"],
      coverUrl: "https://127.0.0.1/private",
    },
  });
  let downloads = 0;
  vi.stubGlobal("fetch", async () => {
    downloads++;
    throw Error("must not fetch");
  });
  const response = await GET(
    new Request("https://library.test/api/books/" + id + "/cover"),
    { params: Promise.resolve({ id: id! }) },
  );
  expect(response.status).toBe(400);
  expect(downloads).toBe(0);
});
