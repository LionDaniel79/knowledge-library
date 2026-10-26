import { beforeAll, afterAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import {
  containsSearchField,
  containsBookTitleSearch,
} from "../src/lib/search-fields";
import { readBookPage } from "../src/server/book-catalog";
import { readNotePage } from "../src/server/record-catalog";
import { readMaterialPage } from "../src/server/material-catalog";
import { searchLibrary } from "../src/server/library-search";
import {
  queryBooks,
  queryNotes,
  querySearch,
  queryMaterials,
  type LocalIndex,
} from "../src/client/replica/queries";
import {
  projectBook,
  projectNote,
  timestampKey,
  sqlTimestamp,
} from "../src/lib/replica/projections";
import { filterNotes, type WhiteboardSnapshot } from "../src/lib/whiteboard";
import { searchFieldSql } from "../src/server/search-sql";

let fixture: Awaited<ReturnType<typeof testDatabase>>, data: LocalIndex;
const owner = "word-search-owner",
  book = randomUUID(),
  note = randomUUID();
const title = "인간 본성의 4중 상태",
  body = "인간의 본성을 읽고 상태가 달라진 이유를 기록한다.";
beforeAll(async () => {
  fixture = await testDatabase();
  await fixture.db.query(
    "INSERT INTO library_books(id,owner_id,title,author,publisher,formats) VALUES($1,$2,$3,'토머스 보스턴','생명의 말씀사',ARRAY['paper'])",
    [book, owner, title],
  );
  await fixture.db.query(
    "INSERT INTO library_notes(id,owner_id,book_id,title,content,kind,tags) VALUES($1,$2,$3,'인간 본성의 기록',$4,'thought',ARRAY['독서 메모'])",
    [note, owner, book, body],
  );
  const b = (
    await fixture.db.query("SELECT * FROM library_books WHERE owner_id=$1", [
      owner,
    ])
  ).rows[0];
  const n = projectNote(
    (
      await fixture.db.query("SELECT * FROM library_notes WHERE owner_id=$1", [
        owner,
      ])
    ).rows[0],
  );
  data = {
    books: [
      {
        book: projectBook(b),
        createdKey: timestampKey(b.created_at),
        createdSql: sqlTimestamp(b.created_at),
      },
    ],
    notes: [n],
    previews: { [note]: n },
    cycles: [],
    excluded: [],
    trash: {},
    shelves: [],
    annualMetrics: [],
    topics: [],
    memberships: [],
    topicLinks: [],
    entries: [
      {
        id: `b:${book}`,
        kind: "book",
        source_id: book,
        version: "1",
        title,
        body: "토머스 보스턴 생명의 말씀사",
        voice: "source",
        coverage: "metadata",
        origin: "original",
        tags: "",
        aux: 0,
      },
      {
        id: `n:${note}`,
        kind: "note",
        source_id: note,
        version: "1",
        title: n.title,
        body,
        voice: "self",
        coverage: "full",
        origin: "original",
        tags: "독서 메모",
        aux: 0,
      },
    ],
  };
});
it("does not evaluate row text for empty searches", async () => {
  await fixture.db.query(
    `CREATE FUNCTION search_word_probe(value text) RETURNS text LANGUAGE plpgsql VOLATILE AS $$ BEGIN RAISE EXCEPTION 'Empty search evaluated row text'; END $$`,
  );
  for (const query of ["", " \t\n", "\u202f\u2007\ufeff"]) {
    const result = await fixture.db.query(
      `SELECT ${searchFieldSql("search_word_probe(title)", "$1")} AS matched FROM library_books WHERE owner_id=$2`,
      [query, owner],
    );
    expect(result.rows).toEqual([{ matched: true }]);
  }
});
afterAll(async () => {
  await fixture?.pg.close();
});

it.each([
  "인간 본성",
  "인간 상태",
  "상태 인간",
  "인간　상태",
  "인간, 상태",
  "인간\u202f상태",
  "인간\u2007상태",
  "인간\ufeff상태",
])(
  "finds every separated or reordered word in %s on server and device",
  async (q) => {
    for (const query of [{ q }, { title: q }]) {
      expect(
        (await readBookPage(fixture.db, owner, query)).items.map((b) => b.id),
      ).toEqual([book]);
      expect(
        (await queryBooks(data, owner, query)).items.map((b) => b.id),
      ).toEqual([book]);
    }
    expect(
      (await readNotePage(fixture.db, owner, { q })).items.map((n) => n.id),
    ).toEqual([note]);
    expect(queryNotes(data, { q }).items.map((n) => n.id)).toEqual([note]);
    expect((await readMaterialPage(fixture.db, owner, { q })).total).toBe(2);
    expect(queryMaterials(data, { q }).total).toBe(2);
    const online = await searchLibrary(fixture.db, owner, {
        text: q,
        layer: "all",
      }),
      device = await querySearch(data, owner, { text: q, layer: "all" });
    expect(online.items.map((h) => h.id).sort()).toEqual(
      [`b:${book}`, `n:${note}`].sort(),
    );
    expect(device.items.map((h) => h.id).sort()).toEqual(
      online.items.map((h) => h.id).sort(),
    );
    expect(online.items.every((h) => h.matchedTerms.includes(q))).toBe(true);
    expect(online.items.find((h) => h.id === `n:${note}`)?.quote).toBe(body);
  },
);

it("applies words within each advanced field and retains AND between fields", async () => {
  const q = {
    title: "인간 상태",
    author: "보스턴 토머스",
    publisher: "생명의 말씀사",
  };
  expect((await readBookPage(fixture.db, owner, q)).total).toBe(1);
  expect((await queryBooks(data, owner, q)).total).toBe(1);
  const mq = {
    title: "인간 기록",
    content: "인간 이유",
    bookTitle: "상태 인간",
    tag: "독서 메모",
  };
  expect((await readNotePage(fixture.db, owner, mq)).total).toBe(1);
  expect(queryNotes(data, mq).total).toBe(1);
  expect(
    (await readBookPage(fixture.db, owner, { ...q, author: "보스턴 없는저자" }))
      .total,
  ).toBe(0);
  expect(
    (await queryBooks(data, owner, { ...q, author: "보스턴 없는저자" })).total,
  ).toBe(0);
});

it("requires all words without weakening owner, exclusion, trash or filter boundaries", async () => {
  for (const q of ["인간 없는단어", "%_ 인간"]) {
    expect((await readBookPage(fixture.db, owner, { q })).total).toBe(0);
    expect((await queryBooks(data, owner, { q })).total).toBe(0);
    expect((await readNotePage(fixture.db, owner, { q })).total).toBe(0);
    expect(queryNotes(data, { q }).total).toBe(0);
    expect((await readMaterialPage(fixture.db, owner, { q })).total).toBe(0);
    expect(queryMaterials(data, { q }).total).toBe(0);
    expect(
      (await searchLibrary(fixture.db, owner, { text: q, layer: "all" })).total,
    ).toBe(0);
    expect(
      (await querySearch(data, owner, { text: q, layer: "all" })).total,
    ).toBe(0);
  }
  expect(
    (await readBookPage(fixture.db, "outsider", { q: "인간 상태" })).total,
  ).toBe(0);
  expect(
    (await readNotePage(fixture.db, "outsider", { q: "인간 상태" })).total,
  ).toBe(0);
  expect(
    (
      await searchLibrary(fixture.db, "outsider", {
        text: "인간 상태",
        layer: "all",
      })
    ).total,
  ).toBe(0);
  expect(
    (await queryBooks({ ...data, excluded: [book] }, owner, { q: "인간 상태" }))
      .total,
  ).toBe(0);
  expect(
    queryNotes({ ...data, trash: { [note]: "2026-10-27" } }, { q: "인간 상태" })
      .total,
  ).toBe(0);
  expect(
    (await readBookPage(fixture.db, owner, { q: "인간 상태", filter: "pdf" }))
      .total,
  ).toBe(0);
});

it("shares word matching with whiteboard records and preserves literal symbols", () => {
  const source: WhiteboardSnapshot = {
    board: null,
    books: data.books.map((b) => b.book),
    notes: data.notes,
    topics: [],
    memberships: [],
    connections: [],
  };
  expect(
    filterNotes(source, {
      topics: [],
      tags: [],
      categories: [],
      books: [],
      q: "이유 인간",
    }).map((n) => n.id),
  ).toEqual([note]);
  expect(containsSearchField(title, "상태 인간")).toBe(true);
  expect(containsBookTitleSearch("우주, 시간, 그 너머", "우주시간")).toBe(true);
  expect(containsSearchField("C++ 프로그래밍", "C#")).toBe(false);
  expect(containsSearchField("C# 프로그래밍", "프로그래밍 C#")).toBe(true);
  expect(containsSearchField("쉼표 없는 책", ",")).toBe(false);
  expect(containsSearchField("우주, 시간", ",")).toBe(true);
  expect(containsSearchField(undefined, "   ")).toBe(true);
});
