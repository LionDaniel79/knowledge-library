import { beforeAll, afterAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { readMaterialPage } from "../src/server/material-catalog";
import {
  buildTopicMaterials,
  pageTopicMaterials,
} from "../src/lib/topic-materials";
import type { Book, Note } from "../src/lib/domain";
import { queryMaterials, type LocalIndex } from "../src/client/replica/queries";
import { timestampKey } from "../src/lib/replica/projections";

let f: Awaited<ReturnType<typeof testDatabase>>;
const owner = "topic-material-test",
  topic = randomUUID(),
  archived = randomUUID();
const book = (title: string, category: string, date: string): Book => ({
  id: randomUUID(),
  title,
  category,
  author: "저자",
  publisher: "출판사",
  isbn: "",
  formats: ["paper"],
  totalPages: null,
  tags: [],
  shelf: "",
  version: 1,
  createdAt: date,
});
const books = [
  book("정서와 작업하기", "186.5", "2020-01-01T00:00:00.000Z"),
  book("넥서스", "300", "2026-01-01T00:00:00.000Z"),
  book("신학의 책", "230.1", "2022-01-01T00:00:00.000Z"),
];
const note = (title: string, bookId: string | null, date: string): Note => ({
  id: randomUUID(),
  title,
  content: "내 생각의 내용",
  kind: "thought",
  bookId,
  page: null,
  version: 1,
  createdAt: date,
  updatedAt: date,
});
const notes = [
  note("오래된 정서", books[0].id, "2018-01-01T00:00:00.000Z"),
  note("최근 정서", books[0].id, "2026-03-01T00:00:00.000Z"),
  note("종교 기록", books[2].id, "2025-01-01T00:00:00.000Z"),
  note("", null, "2026-04-01T00:00:00.000Z"),
];
notes[0].tags = ["관계"];
const topics = [
  { id: topic, name: "감정" },
  { id: archived, name: "지운 주제", archivedAt: "2026-01-01" },
];
const memberships = [
  {
    id: randomUUID(),
    topicId: topic,
    sourceKind: "book",
    sourceId: books[0].id,
    status: "accepted",
  },
  {
    id: randomUUID(),
    topicId: topic,
    sourceKind: "note",
    sourceId: notes[1].id,
    status: "rejected",
  },
  {
    id: randomUUID(),
    topicId: archived,
    sourceKind: "note",
    sourceId: notes[3].id,
    status: "accepted",
  },
];
beforeAll(async () => {
  f = await testDatabase();
  for (const b of books)
    await f.db.query(
      "INSERT INTO library_books(id,owner_id,title,author,publisher,category,created_at,formats) VALUES($1,$2,$3,$4,$5,$6,$7,ARRAY['paper'])",
      [b.id, owner, b.title, b.author, b.publisher, b.category, b.createdAt],
    );
  for (const n of notes)
    await f.db.query(
      "INSERT INTO library_notes(id,owner_id,title,content,kind,book_id,created_at,updated_at,tags) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        n.id,
        owner,
        n.title || "미분류 메모",
        n.content,
        n.kind,
        n.bookId,
        n.createdAt,
        n.updatedAt,
        n.tags ?? [],
      ],
    );
  for (const t of topics)
    await f.db.query(
      "INSERT INTO library_topics(id,owner_id,name,archived_at) VALUES($1,$2,$3,$4)",
      [t.id, owner, t.name, t.archivedAt ?? null],
    );
  for (const m of memberships)
    await f.db.query(
      "INSERT INTO library_topic_memberships(id,owner_id,topic_id,source_kind,source_id,status,source_version,method) VALUES($1,$2,$3,$4,$5,$6,'1','manual')",
      [m.id, owner, m.topicId, m.sourceKind, m.sourceId, m.status],
    );
});
afterAll(async () => f?.pg.close());
const local = (q: unknown) =>
  pageTopicMaterials(
    buildTopicMaterials({ books, notes, topics, memberships }),
    q,
  );
it("combines note kind, tag and linked book before paging on the server and device", async () => {
  const q = {
    kind: "note",
    noteType: "thought",
    tag: "없던태그",
    bookId: books[0].id,
    limit: 10,
  };
  expect(local(q).total).toBe(0);
  expect((await readMaterialPage(f.db, owner, q)).total).toBe(0);
  const match = {
    kind: "note",
    noteType: "thought",
    category: "100",
    tag: "관계",
    bookId: books[0].id,
    topic,
  };
  expect(local(match).items.map((n) => n.id)).toEqual([notes[0].id]);
  expect(
    (await readMaterialPage(f.db, owner, match)).items.map((n) => n.id),
  ).toEqual([notes[0].id]);
  expect(
    local({ kind: "note", noteType: "unclassified" }).items.map((n) => n.id),
  ).toEqual([notes[3].id]);
  expect(
    (
      await readMaterialPage(f.db, owner, {
        kind: "note",
        noteType: "unclassified",
      })
    ).items.map((n) => n.id),
  ).toEqual([notes[3].id]);
  expect(
    local({ kind: "note", bookId: "unlinked" }).items.map((n) => n.id),
  ).toEqual([notes[3].id]);
});

it("the device materials query uses the same classifications and removes trashed records and excluded books", () => {
  const data: LocalIndex = {
    books: books.map((b) => ({
      book: b,
      createdKey: b.createdAt,
      createdSql: b.createdAt,
    })),
    notes,
    previews: {},
    cycles: [],
    excluded: [books[1].id],
    trash: { [notes[2].id]: "2026-01-01" },
    shelves: [],
    annualMetrics: [],
    topics: topics.map((t) => ({
      id: t.id,
      name: t.name,
      archived_at: t.archivedAt,
    })),
    memberships: memberships.map((m) => ({
      topic_id: m.topicId,
      source_kind: m.sourceKind,
      source_id: m.sourceId,
      status: m.status,
    })),
    topicLinks: [],
    entries: [],
  };
  expect(
    queryMaterials(data, {
      kind: "note",
      category: "100",
      topic,
      sort: "newest",
    }).items.map((m) => m.id),
  ).toEqual([notes[0].id]);
  expect(queryMaterials(data, { kind: "note", category: "200" }).total).toBe(0);
  expect(queryMaterials(data, { kind: "book" }).total).toBe(2);
});

it("finds notes through the linked book's main KDC field and keeps unlinked records", async () => {
  for (const category of ["100", "200", "unclassified"]) {
    const expected =
      category === "100"
        ? notes.slice(0, 2).map((n) => n.id)
        : category === "200"
          ? [notes[2].id]
          : [notes[3].id];
    const q = { kind: "note", category, sort: "oldest" };
    const remote = await readMaterialPage(f.db, owner, q);
    expect(remote.items.map((m) => m.id)).toEqual(expected);
    expect(local(q).items.map((m) => m.id)).toEqual(expected);
    expect(remote.total).toBe(expected.length);
  }
});
it("uses book topics for its notes while respecting explicit rejection and archived topics", async () => {
  const q = { kind: "note", topic, sort: "newest" };
  expect(
    (await readMaterialPage(f.db, owner, q)).items.map((m) => m.id),
  ).toEqual([notes[0].id]);
  expect(local(q).items.map((m) => m.id)).toEqual([notes[0].id]);
  const unclassified = { kind: "note", topic: "unclassified", sort: "oldest" };
  expect((await readMaterialPage(f.db, owner, unclassified)).total).toBe(3);
  expect(local(unclassified).total).toBe(3);
  expect((await readMaterialPage(f.db, owner, { topic: archived })).total).toBe(
    0,
  );
});
it("sorts the whole mixed list before slicing and agrees across all five sort modes", async () => {
  for (const sort of ["newest", "oldest", "category", "topic", "book"]) {
    const q = { kind: "all", sort };
    const expected = local(q);
    const pages = [];
    for (let offset = 0; offset < 7; offset += 2) {
      const page = await readMaterialPage(f.db, owner, {
        ...q,
        offset,
        limit: 2,
      });
      expect(page.total).toBe(7);
      pages.push(...page.items);
    }
    expect(
      pages.map((m) => m.id),
      sort,
    ).toEqual(expected.items.map((m) => m.id));
    expect(new Set(pages.map((m) => m.kind + m.id)).size).toBe(7);
  }
  expect(local({ kind: "all", sort: "newest" }).items[0].id).toBe(notes[3].id);
  expect(local({ kind: "all", sort: "oldest" }).items[0].id).toBe(notes[0].id);
});
it("isolates owners, validates sorting, and handles empty or beyond-end pages", async () => {
  expect(
    await readMaterialPage(f.db, "another-owner", { sort: "newest" }),
  ).toEqual({ total: 0, items: [] });
  expect(
    await readMaterialPage(f.db, owner, { offset: 100, sort: "newest" }),
  ).toEqual({ total: 7, items: [] });
  await expect(readMaterialPage(f.db, "", {})).rejects.toMatchObject({
    status: 401,
  });
  await expect(
    readMaterialPage(f.db, owner, { sort: "injected sort" }),
  ).rejects.toThrow();
});

it("preserves compact book-title and category-name search used by other material menus", async () => {
  for (const q of ["정서와작업하기", "철학"]) {
    expect(
      (await readMaterialPage(f.db, owner, { kind: "book", q })).items.map(
        (m) => m.id,
      ),
    ).toEqual([books[0].id]);
    expect(local({ kind: "book", q }).items.map((m) => m.id)).toEqual([
      books[0].id,
    ]);
  }
});

it("preserves submillisecond order in the SQL, pure and projected device material queries", async () => {
  const ns = [
    note("older", null, "2026-01-01T00:00:00.0001Z"),
    note("newer", null, "2026-01-01T00:00:00.0002Z"),
  ];
  ns[0].id = "00000000-0000-4000-8000-000000000001";
  ns[1].id = "00000000-0000-4000-8000-000000000002";
  for (const n of ns)
    await f.db.query(
      "INSERT INTO library_notes(id,owner_id,title,content,kind,created_at,updated_at) VALUES($1,'precision-owner',$2,'thought','thought',$3,$3)",
      [n.id, n.title, n.createdAt],
    );
  const q = { kind: "note", sort: "newest", limit: 1 };
  expect((await readMaterialPage(f.db, "precision-owner", q)).items[0].id).toBe(
    ns[1].id,
  );
  expect(
    pageTopicMaterials(
      buildTopicMaterials({
        books: [],
        notes: ns,
        topics: [],
        memberships: [],
      }),
      q,
    ).items[0].id,
  ).toBe(ns[1].id);
  const data = {
    books: [],
    notes: ns.map((n) => ({
      ...n,
      createdAt: new Date(n.createdAt).toISOString(),
      updatedAt: new Date(n.updatedAt).toISOString(),
    })),
    noteTimeKeys: Object.fromEntries(
      ns.map((n) => [
        n.id,
        {
          created: timestampKey(n.createdAt),
          updated: timestampKey(n.updatedAt),
        },
      ]),
    ),
    previews: {},
    cycles: [],
    excluded: [],
    trash: {},
    shelves: [],
    annualMetrics: [],
    topics: [],
    memberships: [],
    topicLinks: [],
    entries: [],
  } as LocalIndex;
  expect(queryMaterials(data, q).items[0].id).toBe(ns[1].id);
});

it("matches C collation for non-BMP book titles", async () => {
  const bs = [
    book("😀", "100", "2020-01-01Z"),
    book("Ｚ", "100", "2020-01-01Z"),
  ];
  for (const b of bs)
    await f.db.query(
      "INSERT INTO library_books(id,owner_id,title,author,formats) VALUES($1,'unicode-owner',$2,'',ARRAY['paper'])",
      [b.id, b.title],
    );
  const q = { kind: "book" };
  expect(
    (await readMaterialPage(f.db, "unicode-owner", q)).items.map(
      (m) => m.title,
    ),
  ).toEqual(["Ｚ", "😀"]);
  expect(
    pageTopicMaterials(
      buildTopicMaterials({
        books: bs,
        notes: [],
        topics: [],
        memberships: [],
      }),
      q,
    ).items.map((m) => m.title),
  ).toEqual(["Ｚ", "😀"]);
});

it("retains the multi-shelf names in material search", async () => {
  const b = {
    ...book("Alpha", "100", "2020-01-01Z"),
    bookshelves: ["검토 대기열"],
  };
  await f.db.query(
    "INSERT INTO library_books(id,owner_id,title,author,formats,bookshelves) VALUES($1,'shelf-owner',$2,'',ARRAY['paper'],$3)",
    [b.id, b.title, b.bookshelves],
  );
  const q = { kind: "book", q: "검토 대기열" };
  expect((await readMaterialPage(f.db, "shelf-owner", q)).total).toBe(1);
  expect(
    pageTopicMaterials(
      buildTopicMaterials({
        books: [b],
        notes: [],
        topics: [],
        memberships: [],
      }),
      q,
    ).total,
  ).toBe(1);
});
