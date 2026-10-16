import { PGlite } from "@electric-sql/pglite";
import { beforeAll, afterAll, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createLibraryStore } from "../src/server/library-store";
let pg: PGlite;
let store: ReturnType<typeof createLibraryStore>;
const cmd = (type: string, payload: unknown) => ({
  requestId: randomUUID(),
  type,
  payload,
});
beforeAll(async () => {
  pg = new PGlite();
  for (const file of (await readdir("db"))
    .filter((f) => /^\d.*\.sql$/.test(f))
    .sort())
    await pg.exec(await readFile("db/" + file, "utf8"));
  store = createLibraryStore({
    query: (sql, p = []) => pg.query(sql, p),
    transaction: (fn) =>
      pg.transaction((tx) => fn({ query: (sql, p = []) => tx.query(sql, p) })),
  });
});
afterAll(async () => pg?.close());
it("edits book metadata with history and version checks, and keeps shelves owner scoped", async () => {
  const added = await store.mutate(
    "catalog",
    cmd("addBook", { title: "책", formats: ["pdf"], shelf: "원본/책.pdf" }),
  );
  await store.mutate("catalog", cmd("createShelf", { name: "상담 연구" }));
  const edit = {
    id: added.id,
    expectedVersion: 1,
    title: "고친 제목",
    author: "저자",
    formats: ["pdf"],
    shelf: "원본/책.pdf",
    category: "100",
    bookshelves: ["책 대기열", "상담 연구"],
  };
  await store.mutate("catalog", cmd("editBook", edit));
  const snap = await store.snapshot("catalog");
  expect(snap.books[0]).toMatchObject({
    title: "고친 제목",
    category: "100",
    bookshelves: ["책 대기열", "상담 연구"],
    shelf: "원본/책.pdf",
    version: 2,
  });
  expect(await store.revisions("catalog", added.id)).toHaveLength(2);
  await expect(
    store.mutate("catalog", cmd("editBook", edit)),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    store.mutate(
      "other",
      cmd("editBook", { ...edit, expectedVersion: 2, bookshelves: [] }),
    ),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    store.mutate(
      "other",
      cmd("addBook", {
        title: "책",
        formats: ["paper"],
        bookshelves: ["상담 연구"],
      }),
    ),
  ).rejects.toMatchObject({ status: 400 });
});
it("stores editable note tags and rejects unsafe cover URLs", async () => {
  const n = await store.mutate(
    "tags",
    cmd("addNote", { title: "성찰", content: "생각", tags: ["관계", "상담"] }),
  );
  await store.mutate(
    "tags",
    cmd("editNote", {
      id: n.id,
      expectedVersion: 1,
      title: "성찰",
      content: "생각",
      tags: ["상담"],
    }),
  );
  expect((await store.snapshot("tags")).notes[0].tags).toEqual(["상담"]);
  await expect(
    store.mutate(
      "tags",
      cmd("addBook", {
        title: "책",
        formats: ["paper"],
        coverUrl: "javascript:alert(1)",
      }),
    ),
  ).rejects.toThrow();
});

it("invalidates library-verified classification when the edition changes", async () => {
  const b = await store.mutate(
    "edition",
    cmd("addBook", {
      title: "판본",
      isbn: "9780306406157",
      category: "100",
      formats: ["paper"],
    }),
  );
  await pg.query("UPDATE library_books SET classification=$1 WHERE id=$2", [
    JSON.stringify({
      source: "도서관",
      code: "186.3",
      verified: true,
      method: "ISBN 일치",
    }),
    b.id,
  ]);
  await store.mutate(
    "edition",
    cmd("editBook", {
      id: b.id,
      expectedVersion: 1,
      title: "판본",
      isbn: "9788999727764",
      category: "100",
      formats: ["paper"],
    }),
  );
  expect(
    (await store.snapshot("edition")).books[0].classification?.verified,
  ).toBe(false);
});
