import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { createLibraryStore } from "../src/server/library-store";
import { readBookPage, readBookDetail } from "../src/server/book-catalog";
import {
  readNotePage,
  readNoteDetail,
  readCyclePage,
  readReadingCalendar,
} from "../src/server/record-catalog";
import { searchLibrary } from "../src/server/library-search";
import {
  readSyncMeta,
  readSyncChanges,
  scanSyncRows,
} from "../src/server/sync/read";
import { readSyncCoverage } from "../src/server/sync/coverage";
import { readSyncValuePart } from "../src/server/sync/values";
import { createMemoryReplica } from "../src/client/replica/memory-storage";
import { bootstrapReplica } from "../src/client/replica/bootstrap";
import { createReplicaRepository } from "../src/client/replica/repository";
import type { SyncTransport, SyncMeta } from "../src/client/replica/transport";
import { timestampKey } from "../src/lib/replica/projections";
import type { ReplicaStorage } from "../src/client/replica/storage";
import { pullReplica } from "../src/client/replica/pull";
import { createKnowledgeStore } from "../src/server/knowledge-store";
import { createThoughtMapStore } from "../src/server/thought-map-store";
import { readCurationDetails } from "../src/server/curation-store";
import { readBookIntroduction } from "../src/server/book-introduction";
import {
  readCatalogReviews,
  importCatalogReviewBatch,
} from "../src/server/catalog-review-store";
import { readMaterialPage } from "../src/server/material-catalog";
let f: Awaited<ReturnType<typeof testDatabase>>,
  repo: ReturnType<typeof createReplicaRepository>,
  books: string[] = [],
  noteId: string;
let storage: ReplicaStorage,
  transport: SyncTransport,
  bookPageReads = 0,
  revisionPageReads = 0;
const owner = "parity-owner",
  json = (v: unknown) => JSON.parse(JSON.stringify(v));
function pagePosition(value: any, sort = "newest") {
  const page = json(value);
  if (page.nextCursor) {
    const c = JSON.parse(
      Buffer.from(page.nextCursor, "base64url").toString("utf8"),
    );
    if (sort === "newest" || sort === "oldest")
      c.keys[0] = timestampKey(c.keys[0]);
    page.nextCursor = c;
  }
  return page;
}
beforeAll(async () => {
  f = await testDatabase();
  const store = createLibraryStore(f.db),
    cmd = (type: string, payload: unknown) => ({
      type,
      payload,
      requestId: randomUUID(),
    });
  for (const [title, author, category, formats] of [
    ["개성의 탄생", "김 저자", "100", ["paper"]],
    ["넥서스", "유발 하라리", "300", ["ebook"]],
    ["성경 해석", "이 저자", "200", ["pdf"]],
    ["제외 자료", "박 저자", "100", ["pdf"]],
  ] as const) {
    books.push(
      (
        await store.mutate(
          owner,
          cmd("addBook", {
            title,
            author,
            category,
            formats: [...formats],
            tags: ["독서"],
            bookshelves: ["책 대기열"],
          }),
        )
      ).id!,
    );
  }
  await f.db.query(
    "UPDATE library_books SET created_at='2026-10-17T01:00:00.123456Z' WHERE owner_id=$1",
    [owner],
  );
  await f.db.query(
    "INSERT INTO library_book_exclusions(id,owner_id,kind,reason,batch_id) VALUES($1,$2,'paper','검증',$3)",
    [books[3], owner, randomUUID()],
  );
  noteId = (
    await store.mutate(
      owner,
      cmd("addNote", {
        title: "독서 메모",
        content: "아버지께 드림. 개성의 탄생을 읽으며 내 생각을 남긴다.",
        kind: "thought",
        bookId: books[0],
        tags: ["독서 메모"],
      }),
    )
  ).id!;
  await f.db.query(
    "UPDATE library_notes SET created_at='2018-01-31T15:30:00Z',updated_at='2026-10-17T01:00:00Z' WHERE owner_id=$1 AND id=$2",
    [owner, noteId],
  );
  const trash = (
    await store.mutate(
      owner,
      cmd("addNote", {
        title: "휴지통의 글",
        content: "감춰진 원문",
        kind: "note",
        tags: ["독서 메모"],
      }),
    )
  ).id!;
  await store.mutate(
    owner,
    cmd("deleteNote", { id: trash, expectedVersion: 1 }),
  );
  for (const bookId of [books[0], books[0], books[1], books[3]])
    await f.db.query(
      "INSERT INTO library_cycles(id,owner_id,book_id,status,completed_on,current_page) VALUES($1,$2,$3,'completed','2026-10-15',100)",
      [randomUUID(), owner, bookId],
    );
  await f.db.query(
    "INSERT INTO library_cycles(id,owner_id,book_id,status,started_on) VALUES($1,$2,$3,'reading','2026-10-16')",
    [randomUUID(), owner, books[2]],
  );
  const target = "00000000-0000-4000-8000-000000000001";
  for (let i = 0; i < 26; i++)
    await f.db.query(
      "INSERT INTO library_books(id,owner_id,title,formats,created_at) VALUES($1,$2,$3,ARRAY['paper'],'2010-01-01')",
      [i === 0 ? target : randomUUID(), owner, "보조 도서 " + i],
    );
  await f.db.query(
    "INSERT INTO library_connections(id,owner_id,source_kind,source_id,target_kind,target_id,relation,reason,status) VALUES($1,$2,'book',$3,'book',$4,'related','추가 연결','accepted')",
    [randomUUID(), owner, books[0], target],
  );
  await f.db.query(
    "INSERT INTO library_revisions(id,owner_id,entity_id,action,after_data,created_at) VALUES($1,$2,$3,'fixtureHistory','{}','2019-01-01')",
    [randomUUID(), owner, noteId],
  );
  const asset = randomUUID(),
    coverHash = "a".repeat(64),
    cover = "https://image.yes24.com/fixture.jpg";
  await f.db.query(
    "INSERT INTO library_cover_assets(id,owner_id,sha256,data_base64,mime) VALUES($1,$2,$3,'YWJj','image/webp')",
    [asset, owner, coverHash],
  );
  for (const source of [cover, "import:" + coverHash])
    await f.db.query(
      "INSERT INTO library_cover_mirrors(id,owner_id,source,asset_id) VALUES($1,$2,$3,$4)",
      [randomUUID(), owner, source, asset],
    );
  await f.db.query(
    "UPDATE library_books SET cover_url=$3,source_data=$4::jsonb WHERE owner_id=$1 AND id=$2",
    [
      owner,
      books[0],
      cover,
      JSON.stringify({
        app: "iReadItNow HD",
        libraryId: "old",
        recordId: "fixture",
        cover: { sha256: coverHash, mime: "image/webp", bytes: 3 },
        raw: { source: "kept" },
      }),
    ],
  );
  transport = {
    meta: async (inventory) =>
      (await readSyncMeta(f.db, owner, inventory)) as SyncMeta,
    scan: (entity, after) => scanSyncRows(f.db, owner, { entity, after }),
    changes: (epoch, cursor) => readSyncChanges(f.db, owner, { epoch, cursor }),
    value: (row, index) =>
      readSyncValuePart(f.db, owner, {
        entity: row.entity,
        key: row.key,
        revision: row.revision,
        index,
      }),
    coverage: () => readSyncCoverage(f.db, owner),
  };
  const s = createMemoryReplica(owner);
  storage = {
    ...s,
    readPage: async (entity, input) => {
      if (entity === "library_books") bookPageReads++;
      if (entity === "library_revisions") revisionPageReads++;
      return s.readPage(entity, input);
    },
  };
  await bootstrapReplica({ owner, storage, transport });
  repo = createReplicaRepository(storage);
});
afterAll(async () => {
  repo?.close();
  await f?.pg.close();
});
it("matches server contracts for review detail, sources, thought events, research and mixed material pages", async () => {
  const b = (
    await f.db.query(
      "SELECT * FROM library_books WHERE owner_id=$1 AND id=$2",
      [owner, books[0]],
    )
  ).rows[0];
  await importCatalogReviewBatch(f.db, owner, [
    {
      bookId: b.id,
      sourceVersion: b.version,
      record: {
        provider: "예스24",
        url: "https://www.yes24.com/product/goods/1",
        isbn: "9791194330424",
        title: b.title,
        facts: {
          title: b.title,
          author: b.author,
          publisher: b.publisher,
          isbn: "9791194330424",
          coverUrl: "",
        },
        toc: ["보존한 목차"],
      },
    },
  ]);
  await pullReplica({ owner, storage, transport });
  const clean = (v: unknown) =>
    JSON.parse(JSON.stringify(v, (k, v) => (k === "owner_id" ? undefined : v)));
  for (const [path, server] of [
    ["/api/knowledge", await createKnowledgeStore(f.db).snapshot(owner)],
    ["/api/thought-map", await createThoughtMapStore(f.db).snapshot(owner)],
    [
      "/api/curation?kind=book&id=" + b.id,
      await readCurationDetails(f.db, owner, "book", b.id),
    ],
    [
      "/api/book-introduction?id=" + b.id,
      await readBookIntroduction(f.db, owner, b.id),
    ],
    [
      "/api/catalog-review?groupBy=book",
      await readCatalogReviews(f.db, owner, { groupBy: "book" }),
    ],
    [
      "/api/library-materials?limit=10",
      await readMaterialPage(f.db, owner, { limit: 10 }),
    ],
  ] as const)
    expect(clean(await repo.read(path)), path).toEqual(clean(server));
  const reviews = await readCatalogReviews(f.db, owner, {});
  const id = reviews.items[0].id;
  expect(clean(await repo.read("/api/catalog-review?id=" + id))).toEqual(
    clean(await readCatalogReviews(f.db, owner, { id })),
  );
});
it("matches SQL book pages, categories, formats, shelves, whitespace search and deterministic sorting", async () => {
  for (const query of [
    {},
    { sort: "title" },
    { sort: "author" },
    { sort: "oldest" },
    { q: "개성의탄생" },
    { category: "100" },
    { filter: "completed" },
    { filter: "pdf" },
    { shelf: "책 대기열" },
    { limit: 1, offset: 1 },
  ])
    expect(pagePosition(await repo.books(query), query.sort)).toEqual(
      pagePosition(await readBookPage(f.db, owner, query), query.sort),
    );
  const server = await readBookPage(f.db, owner, { limit: 1 }),
    local = await repo.books({ limit: 1 });
  expect(
    pagePosition(await repo.books({ limit: 1, cursor: server.nextCursor })),
  ).toEqual(
    pagePosition(
      await readBookPage(f.db, owner, { limit: 1, cursor: local.nextCursor }),
    ),
  );
  expect(json(await repo.book(books[0]))).toEqual(
    json(await readBookDetail(f.db, owner, books[0])),
  );
  await expect(repo.book(books[3])).rejects.toMatchObject({ status: 404 });
});
it("matches note tags, Seoul dates, previews and full text, while keeping the trash out of active results", async () => {
  for (const query of [
    {},
    { tag: "독서 메모" },
    { from: "2018-02-01", to: "2018-02-01" },
    { from: "2018-01-31", to: "2018-01-31" },
    { book: books[0] },
    { q: "아버지" },
    { kind: "note" },
  ])
    expect(json(await repo.notes(query))).toEqual(
      json(await readNotePage(f.db, owner, query)),
    );
  expect(json(await repo.note(noteId))).toEqual(
    json(await readNoteDetail(f.db, owner, noteId)),
  );
});
it("matches reading history, calendar counts and the home overview without excluded books", async () => {
  expect(json(await repo.reading({ date: "2026-10-15" }))).toEqual(
    json(await readCyclePage(f.db, owner, { date: "2026-10-15" })),
  );
  expect(json(await repo.calendar("2026-10"))).toEqual(
    json(await readReadingCalendar(f.db, owner, "2026-10")),
  );
  const local = await repo.overview(),
    server = await createLibraryStore(f.db).overview(owner);
  expect({
    ...json(local),
    catalog: {
      ...local.catalog,
      firstPage: pagePosition(local.catalog!.firstPage),
    },
  }).toEqual({
    ...json(server),
    catalog: {
      ...server.catalog,
      firstPage: pagePosition(server.catalog!.firstPage),
    },
  });
});
it("retains complete revision history in server order", async () => {
  expect(await repo.history(noteId)).toEqual(
    await createLibraryStore(f.db).revisions(owner, noteId),
  );
  revisionPageReads = 0;
  expect(await repo.history(noteId)).toEqual(
    await createLibraryStore(f.db).revisions(owner, noteId),
  );
  expect(revisionPageReads).toBe(0);
});
it("reuses its local search index after a change unrelated to the catalog or notes", async () => {
  await repo.books({});
  bookPageReads = 0;
  await f.db.query(
    "INSERT INTO library_operations(owner_id,request_id,fingerprint,result) VALUES($1,$2,$3,'{}')",
    [owner, randomUUID(), "0".repeat(64)],
  );
  await pullReplica({ owner, storage, transport });
  await repo.books({});
  expect(bookPageReads).toBe(0);
});
it("matches layered search ranking and quotes for my thoughts, source metadata and compact titles", async () => {
  for (const query of [
    { text: "아버지", layer: "all" },
    { text: "개성의탄생", layer: "all" },
    { text: "개성", layer: "mine" },
    { text: "개성", layer: "source" },
  ] as const)
    expect(json(await repo.search(query))).toEqual(
      json(await searchLibrary(f.db, owner, query)),
    );
});
