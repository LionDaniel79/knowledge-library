import { beforeAll, afterAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { readMaterialPage } from "../src/server/material-catalog";
import { readCyclePage } from "../src/server/record-catalog";
import { searchLibrary } from "../src/server/library-search";
let f: Awaited<ReturnType<typeof testDatabase>>;
const owner = "page-owner",
  topic = randomUUID();
beforeAll(async () => {
  f = await testDatabase();
  await f.db.query(
    "INSERT INTO library_topics(id,owner_id,name) VALUES($1,$2,'분류')",
    [topic, owner],
  );
  for (let i = 0; i < 65; i++) {
    const book = randomUUID(),
      note = randomUUID();
    await f.db.query(
      "INSERT INTO library_books(id,owner_id,title,author,category,formats) VALUES($1,$2,$3,'저자','100',ARRAY['paper'])",
      [book, owner, `검색 자료 ${String(i).padStart(2, "0")}`],
    );
    if (i < 12) {
      await f.db.query(
        "INSERT INTO library_notes(id,owner_id,title,content,kind,book_id) VALUES($1,$2,$3,'내 생각','thought',$4)",
        [note, owner, `검색 기록 ${i}`, book],
      );
      await f.db.query(
        "INSERT INTO library_topic_memberships(id,owner_id,source_kind,source_id,source_version,topic_id,status,method) VALUES($1,$2,'note',$3,'1',$4,'accepted','manual')",
        [randomUUID(), owner, note, topic],
      );
    }
    await f.db.query(
      "INSERT INTO library_cycles(id,owner_id,book_id,status,completed_on) VALUES($1,$2,$3,'completed','2026-10-01')",
      [randomUUID(), owner, book],
    );
  }
});
afterAll(async () => f?.pg.close());

it("pages across notes and books without accumulating or skipping the boundary", async () => {
  const a = await readMaterialPage(f.db, owner, { limit: 10 });
  const b = await readMaterialPage(f.db, owner, { limit: 10, offset: 10 });
  expect(a.total).toBe(77);
  expect(a.items.every((x) => x.kind === "note")).toBe(true);
  expect(b.items.map((x) => x.kind)).toEqual([
    "note",
    "note",
    ...Array(8).fill("book"),
  ]);
  expect(new Set([...a.items, ...b.items].map((x) => x.kind + x.id)).size).toBe(
    20,
  );
  const assigned = await readMaterialPage(f.db, owner, {
    topic,
    category: "100",
    limit: 50,
  });
  expect(assigned.total).toBe(12);
  expect(assigned.items.every((x) => x.kind === "note")).toBe(true);
  expect(assigned.items.every((x) => x.category === "100")).toBe(true);
  expect((await readMaterialPage(f.db, "other-owner", { topic })).total).toBe(
    0,
  );
  await expect(readMaterialPage(f.db, "", {})).rejects.toMatchObject({
    status: 401,
  });
});

it("uses the requested size for reading history and exact search totals, even past the last page", async () => {
  const a = await readCyclePage(f.db, owner, { limit: 15 });
  const b = await readCyclePage(f.db, owner, { limit: 15, offset: 15 });
  expect(a.items).toHaveLength(15);
  expect(new Set([...a.items, ...b.items].map((x) => x.id)).size).toBe(30);
  const q = { text: "검색", layer: "all" as const, limit: 50 };
  const first = await searchLibrary(f.db, owner, q);
  const last = await searchLibrary(f.db, owner, { ...q, offset: 50 });
  expect(first.total).toBe(77);
  expect(first.items).toHaveLength(50);
  expect(last.total).toBe(77);
  expect(last.items).toHaveLength(27);
  expect(new Set([...first.items, ...last.items].map((x) => x.id)).size).toBe(
    77,
  );
  expect(await searchLibrary(f.db, owner, { ...q, offset: 100 })).toMatchObject(
    { total: 77, items: [] },
  );
  expect((await searchLibrary(f.db, "other-owner", q)).total).toBe(0);
});
