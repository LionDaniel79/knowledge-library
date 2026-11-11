import { expect, it } from "vitest";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { createLibraryStore } from "../src/server/library-store";
import { readBookPage } from "../src/server/book-catalog";
import { readCurationSource } from "../src/server/curation-store";
it("removes web source endpoints and dedicated access/search code", () => {
  for (const path of [
    "src/app/api/pdf/route.ts",
    "src/app/api/pdf/[id]/file/route.ts",
    "src/app/api/pdf/[id]/page/route.ts",
    "src/app/api/pdf/citation/route.ts",
    "src/app/api/library-operations/route.ts",
    "src/app/api/pc-access/route.ts",
    "src/app/reader/[id]/page.tsx",
    "src/server/pdf-search.ts",
    "src/lib/pc-access.ts",
    "src/local/pdf-search.mjs",
  ])
    expect(existsSync(path), path).toBe(false);
  expect(existsSync("desktop/pdf-library/reader.py")).toBe(true);
});
it("keeps PDF bibliography CRUD, stored quote/page/source, reading and book relationships independent of a viewer", async () => {
  const f = await testDatabase();
  const owner = "preserved-pdf";
  const store = createLibraryStore(f.db);
  const command = (type: string, payload: any) =>
    ({ requestId: randomUUID(), type, payload }) as any;
  try {
    await store.mutate(owner, command("createShelf", { name: "연구" }));
    const b = await store.mutate(
      owner,
      command("addBook", {
        title: "PDF 서지",
        author: "저자",
        isbn: "9780000000002",
        formats: ["pdf"],
        bookshelves: ["연구"],
        tags: ["자료"],
      }),
    );
    const n = await store.mutate(
      owner,
      command("addNote", {
        bookId: b.id,
        title: "인용",
        kind: "highlight",
        content: "보존할 원문 인용",
        page: 42,
        tags: ["근거"],
      }),
    );
    const source = {
      app: "PDF",
      libraryId: "original",
      recordId: "old-citation",
      raw: {
        pageNumber: 42,
        signature: "saved-signature",
        quote: "보존할 원문 인용",
      },
    };
    await f.db.query(
      "UPDATE library_notes SET source_data=$3 WHERE owner_id=$1 AND id=$2",
      [owner, n.id, JSON.stringify(source)],
    );
    const cycle = await store.mutate(
      owner,
      command("startReading", { bookId: b.id, startedOn: "2026-11-01" }),
    );
    const before = await store.snapshot(owner);
    await store.mutate(
      owner,
      command("editBook", {
        ...before.books[0],
        title: "수정한 PDF 서지",
        expectedVersion: before.books[0].version,
      }),
    );
    const after = await store.snapshot(owner);
    expect(after.notes).toEqual(before.notes);
    expect(after.cycles).toEqual(before.cycles);
    expect(after.notes[0]).toMatchObject({
      content: "보존할 원문 인용",
      page: 42,
      bookId: b.id,
      sourceData: source,
    });
    expect(after.cycles[0].id).toBe(cycle.id);
    expect(
      (await readBookPage(f.db, owner, { filter: "pdf" })).items[0],
    ).toMatchObject({ id: b.id, title: "수정한 PDF 서지", formats: ["pdf"] });
    const count = (
      await f.db.query(
        "SELECT count(*)::int n FROM library_notes WHERE owner_id=$1",
        [owner],
      )
    ).rows[0].n;
    await expect(
      readCurationSource(f.db, owner, {
        kind: "pdf_chunk",
        id: "old:42",
        version: "old",
      }),
    ).rejects.toMatchObject({ status: 410 });
    expect(
      (
        await f.db.query(
          "SELECT count(*)::int n FROM library_notes WHERE owner_id=$1",
          [owner],
        )
      ).rows[0].n,
    ).toBe(count);
  } finally {
    await f.pg.close();
  }
});
