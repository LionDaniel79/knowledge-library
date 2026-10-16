import { beforeAll, afterAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { createLibraryStore } from "../src/server/library-store";
import {
  readBookPage,
  readBookDetail,
  readBooksByIds,
} from "../src/server/book-catalog";
let f: Awaited<ReturnType<typeof testDatabase>>, ids: string[], topic: string;
beforeAll(async () => {
  f = await testDatabase();
  ids = Array.from({ length: 55 }, () => randomUUID()).sort();
  topic = randomUUID();
  for (let i = 0; i < ids.length; i++)
    await f.db.query(
      "INSERT INTO library_books(id,owner_id,title,author,formats,created_at,category,bookshelves,source_data) VALUES($1,'reader',$2,$3,$4,'2026-10-01T00:00:00.123456Z',$5,$6,$7)",
      [
        ids[i],
        i === 54 ? "100%_의 확률" : "같은 제목",
        i < 30 ? "가 저자" : "나 저자",
        i < 30 ? ["paper"] : ["pdf"],
        i < 30 ? "100" : "200",
        [i < 30 ? "대기열" : "완료"],
        JSON.stringify({
          app: "iReadItNow HD",
          libraryId: "l",
          recordId: String(i),
          raw: { large: "x".repeat(1000) },
          sessions: [{ raw: { text: "원래 자료" } }],
        }),
      ],
    );
  await f.db.query(
    "INSERT INTO library_books(id,owner_id,title,formats) VALUES($1,'outsider','비공개',ARRAY['paper'])",
    [randomUUID()],
  );
  await f.db.query(
    "INSERT INTO library_cycles(id,owner_id,book_id,status,completed_on) VALUES($1,'reader',$2,'completed','2026-10-01')",
    [randomUUID(), ids[0]],
  );
  await f.db.query(
    "INSERT INTO library_notes(id,owner_id,book_id,title,content,kind) VALUES($1,'reader',$2,'메모','내 생각','thought')",
    [randomUUID(), ids[1]],
  );
  await f.db.query(
    "INSERT INTO library_topics(id,owner_id,name) VALUES($1,'reader','질문')",
    [topic],
  );
  await f.db.query(
    "INSERT INTO library_topic_memberships(id,owner_id,topic_id,source_kind,source_id,source_version,status,method) VALUES($1,'reader',$2,'book',$3,'1','accepted','manual')",
    [randomUUID(), topic, ids[54]],
  );
});
afterAll(async () => await f?.pg.close());
it("finds titles and authors with different spacing while keeping literal punctuation and owner isolation", async () => {
  const owner = "spacing-catalog",
    id = randomUUID();
  await f.db.query(
    "INSERT INTO library_books(id,owner_id,title,author,formats) VALUES($1,$2,'인간 본성의 4중 상태','토마스 보스턴',ARRAY['paper'])",
    [id, owner],
  );
  for (const q of [
    "인간 본성의 4중상태",
    "인간본성의4중상태",
    "토마스보스턴",
  ]) {
    const result = await readBookPage(f.db, owner, { q });
    expect(result.items.map((x) => x.id)).toEqual([id]);
    expect(result.items[0].title).toBe("인간 본성의 4중 상태");
    expect((await readBookPage(f.db, "spacing-outsider", { q })).items).toEqual(
      [],
    );
  }
  expect((await readBookPage(f.db, owner, { q: "%_" })).items).toEqual([]);
});
it("paginates tied sort values without duplicates or omissions and keeps raw imports out of list responses", async () => {
  for (const sort of ["newest", "oldest", "title", "author"]) {
    const found: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await readBookPage(f.db, "reader", {
        sort,
        limit: 10,
        ...(cursor ? { cursor } : {}),
      });
      expect(page.total).toBe(55);
      expect(page.items.length).toBeLessThanOrEqual(10);
      for (const b of page.items) {
        expect(b.sourceData?.raw).toEqual({});
        expect(b.sourceData?.sessions).toBeUndefined();
      }
      found.push(...page.items.map((b) => b.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(new Set(found).size).toBe(55);
    expect([...found].sort()).toEqual(ids);
    if (sort === "newest") expect(found).toEqual([...ids].reverse());
    if (sort === "oldest") expect(found).toEqual(ids);
  }
});
it("searches literal punctuation, filters across the whole catalog and protects owner-bound details/cursors", async () => {
  expect(
    (await readBookPage(f.db, "reader", { q: "%_" })).items.map((b) => b.id),
  ).toEqual([ids[54]]);
  expect(
    (
      await readBookPage(f.db, "reader", {
        category: "100",
        filter: "paper",
        shelf: "대기열",
      })
    ).total,
  ).toBe(30);
  expect(
    (await readBookPage(f.db, "reader", { filter: "completed" })).items.map(
      (b) => b.id,
    ),
  ).toEqual([ids[0]]);
  expect(
    (await readBookPage(f.db, "reader", { topic })).items.map((b) => b.id),
  ).toEqual([ids[54]]);
  expect(
    (await readBookPage(f.db, "reader", { topic: "unclassified" })).total,
  ).toBe(54);
  expect(
    (await readBookDetail(f.db, "reader", ids[54])).sourceData?.raw.large,
  ).toHaveLength(1000);
  await expect(readBookDetail(f.db, "outsider", ids[54])).rejects.toMatchObject(
    { status: 404 },
  );
  expect(await readBooksByIds(f.db, "outsider", [ids[54]])).toEqual([]);
  const p = await readBookPage(f.db, "reader", { limit: 10 });
  await expect(
    readBookPage(f.db, "outsider", { limit: 10, cursor: p.nextCursor! }),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    readBookPage(f.db, "reader", {
      q: "different",
      limit: 10,
      cursor: p.nextCursor!,
    }),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    readBookPage(f.db, "reader", { cursor: "broken" }),
  ).rejects.toThrow();
  await expect(
    readBookPage(f.db, "reader", { limit: 10001 }),
  ).rejects.toThrow();
});
it("initial overview includes only a page and books needed by reading/notes while counts and full exports remain complete", async () => {
  const store = createLibraryStore(f.db);
  const overview = await store.overview("reader");
  expect(overview.catalog?.total).toBe(55);
  expect(overview.catalog?.formatCounts).toMatchObject({ paper: 30, pdf: 25 });
  expect(overview.catalog?.categoryCounts).toMatchObject({
    "100": 30,
    "200": 25,
  });
  expect(overview.catalog?.firstPage.items).toHaveLength(24);
  expect(overview.books.length).toBeLessThan(30);
  expect(overview.books.map((b) => b.id)).toContain(ids[0]);
  expect(overview.books.map((b) => b.id)).toContain(ids[1]);
  expect(overview.cycles).toHaveLength(1);
  expect(overview.notes).toHaveLength(1);
  expect((await store.snapshot("reader")).books).toHaveLength(55);
  expect(
    (await store.exportLibrary("reader")).library.books[0].sourceData?.raw
      .large,
  ).toHaveLength(1000);
});
