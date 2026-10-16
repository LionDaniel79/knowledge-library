import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { createLibraryStore } from "../src/server/library-store";
import {
  readNotePage,
  readNoteDetail,
  readReadingSummary,
} from "../src/server/record-catalog";
it("searches full content beyond the preview, loads exact bodies and keeps whole-history statistics", async () => {
  const f = await testDatabase();
  try {
    const owner = "paging",
      store = createLibraryStore(f.db),
      b = await store.mutate(owner, {
        type: "addBook",
        requestId: randomUUID(),
        payload: { title: "책", formats: ["paper"] },
      });
    for (let i = 0; i < 28; i++)
      await store.mutate(owner, {
        type: "addNote",
        requestId: randomUUID(),
        payload: {
          title: `기록${i}`,
          content: "가".repeat(2000) + (i === 0 ? "숨은검색어" : "끝"),
          kind: "thought",
          tags: ["분류"],
          bookId: b.id,
        },
      });
    const overview = await store.overview(owner);
    expect(overview.notes.every((n) => n.content.length <= 240)).toBe(true);
    const page = await readNotePage(f.db, owner, { q: "숨은검색어" });
    expect(page.total).toBe(1);
    expect(
      (await readNoteDetail(f.db, owner, page.items[0].id)).content.length,
    ).toBeGreaterThan(2000);
    expect((await readNotePage(f.db, owner, {})).items.length).toBe(24);
    const firstTen = await readNotePage(f.db, owner, { limit: 10 });
    const nextTen = await readNotePage(f.db, owner, { limit: 10, offset: 10 });
    expect(firstTen.items).toHaveLength(10);
    expect(nextTen.items).toHaveLength(10);
    expect(nextTen.total).toBe(28);
    expect(
      new Set([...firstTen.items, ...nextTen.items].map((n) => n.id)).size,
    ).toBe(20);
    expect((await readNotePage(f.db, owner, { limit: 50 })).items).toHaveLength(
      28,
    );
    expect((await readNotePage(f.db, "other", {})).total).toBe(0);
    await f.db.query(
      "insert into library_cycles(id,owner_id,book_id,status,completed_on) values($1,$2,$3,'completed','2020-01-01'),($4,$2,$3,'completed','2026-10-01'),($5,$2,$3,'completed',NULL)",
      [randomUUID(), owner, b.id, randomUUID(), randomUUID()],
    );
    expect(await readReadingSummary(f.db, owner)).toMatchObject({
      totalCompleted: 3,
      undatedCount: 1,
      months: { "2026-10": { monthCount: 1, rereads: 1, uniqueBooks: 1 } },
    });
    expect((await store.overview(owner)).cycles).toHaveLength(0);
    expect((await store.snapshot(owner)).cycles).toHaveLength(3);
  } finally {
    await f.pg.close();
  }
});
