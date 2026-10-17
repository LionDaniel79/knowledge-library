import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { testDatabase } from "./helpers/database";
import { createLibraryStore } from "../src/server/library-store";
import { createBookExclusionStore } from "../src/server/book-exclusions";
import { readBookPage, readCatalogCounts } from "../src/server/book-catalog";
import { searchLibrary } from "../src/server/library-search";
import { importPdfCatalog } from "../src/server/pdf-catalog-import";
import {
  createLibraryBackup as createBackup,
  inspectLibraryBackup as inspectBackup,
  restoreLibraryBackup as restoreBackup,
} from "../src/server/library-backup";
import { createKnowledgeStore } from "../src/server/knowledge-store";
import { createThoughtMapStore } from "../src/server/thought-map-store";
import { readSourcePage } from "../src/server/thought-source-pages";
import { bookDuplicateCandidates } from "../src/server/book-duplicates";
let f: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  f = await testDatabase();
});
afterAll(async () => {
  await f?.pg.close();
});
const op = (type: string, payload: unknown) => ({
  type,
  payload,
  requestId: randomUUID(),
});
function file(kind = "paper") {
  const id = randomUUID();
  return {
    id,
    root: "E:/전자도서관",
    path: `E:/전자도서관/${id}.pdf`,
    relative_path: `${id}.pdf`,
    title: `검증자료 ${id}`,
    author: "저자",
    page_count: 12,
    bytes: 1024,
    mtime_ns: "123456789",
    processing_scope: kind === "book" ? "full" : "metadata_only",
    material_kind: kind,
    scope_reason: "검증용 분류",
    scope_version: "test",
  };
}
async function imported(owner: string, kind = "paper") {
  const doc = file(kind);
  await importPdfCatalog(f.db, owner, [doc]);
  const book = (
    await f.db.query(
      "SELECT b.id,b.version FROM library_books b JOIN library_documents d ON d.owner_id=b.owner_id AND d.book_id=b.id WHERE d.owner_id=$1 AND d.id=$2",
      [owner, doc.id],
    )
  ).rows[0];
  return {
    doc,
    book,
    selection: { id: book.id, expectedVersion: book.version, kind },
  };
}
it("hides only the selected papers, keeps deferred material and all original rows, and survives real importer replay", async () => {
  const owner = "exclusion-owner",
    s = createBookExclusionStore(f.db);
  const a = await imported(owner),
    periodical = await imported(owner, "periodical"),
    review = await imported(owner, "review"),
    regular = await imported(owner, "book");
  const command = {
    requestId: randomUUID(),
    items: [a.selection, periodical.selection],
  };
  expect(await s.exclude(owner, command)).toMatchObject({ excluded: 2 });
  expect(await s.exclude(owner, command)).toMatchObject({ excluded: 2 });
  expect(
    (await readBookPage(f.db, owner, {})).items.map((b) => b.id).sort(),
  ).toEqual([review.book.id, regular.book.id].sort());
  expect((await readCatalogCounts(f.db, owner)).total).toBe(2);
  expect((await createLibraryStore(f.db).overview(owner)).catalog?.total).toBe(
    2,
  );
  expect((await createLibraryStore(f.db).snapshot(owner)).books).toHaveLength(
    2,
  );
  await importPdfCatalog(f.db, owner, [
    a.doc,
    periodical.doc,
    review.doc,
    regular.doc,
  ]);
  expect((await s.list(owner, {})).total).toBe(2);
  expect(
    (
      await f.db.query("SELECT id FROM library_books WHERE owner_id=$1", [
        owner,
      ])
    ).rows,
  ).toHaveLength(4);
  expect(
    (
      await f.db.query("SELECT id FROM library_documents WHERE owner_id=$1", [
        owner,
      ])
    ).rows,
  ).toHaveLength(4);
  expect((await readBookPage(f.db, owner, { q: a.doc.title })).total).toBe(0);
  expect(
    (await searchLibrary(f.db, owner, { text: a.doc.title, layer: "all" }))
      .items,
  ).toHaveLength(0);
});
it("restores explicitly with owner, version and idempotency checks; importer replay honors the restoration", async () => {
  const owner = "restore-excluded",
    s = createBookExclusionStore(f.db),
    a = await imported(owner);
  const initialBatch = { requestId: randomUUID(), items: [a.selection] };
  await s.exclude(owner, initialBatch);
  const entry = (await s.list(owner, {})).items[0];
  await expect(
    s.restore("another-owner", {
      id: a.book.id,
      expectedVersion: entry.version,
      requestId: randomUUID(),
    }),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    s.restore(owner, {
      id: a.book.id,
      expectedVersion: 999,
      requestId: randomUUID(),
    }),
  ).rejects.toMatchObject({ status: 409 });
  const command = {
    id: a.book.id,
    expectedVersion: entry.version,
    requestId: randomUUID(),
  };
  const result = await s.restore(owner, command);
  expect(await s.restore(owner, command)).toEqual(result);
  await expect(
    s.restore(owner, { ...command, requestId: randomUUID() }),
  ).rejects.toMatchObject({ status: 409 });
  await importPdfCatalog(f.db, owner, [a.doc]);
  await s.exclude(owner, initialBatch);
  expect((await readBookPage(f.db, owner, {})).total).toBe(1);
  expect((await s.list(owner, {})).total).toBe(0);
});
it("rejects changed classifications/versions and atomically preserves every record in an invalid batch", async () => {
  const owner = "exclude-stale",
    s = createBookExclusionStore(f.db),
    a = await imported(owner),
    b = await imported(owner, "review");
  await expect(
    s.exclude(owner, {
      requestId: randomUUID(),
      items: [a.selection, { ...b.selection, kind: "paper" }],
    }),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    s.exclude(owner, {
      requestId: randomUUID(),
      items: [{ ...a.selection, expectedVersion: 99 }],
    }),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    s.exclude("other", { requestId: randomUUID(), items: [a.selection] }),
  ).rejects.toMatchObject({ status: 409 });
  expect((await readBookPage(f.db, owner, {})).total).toBe(2);
  expect((await s.list(owner, {})).total).toBe(0);
});
it("hides excluded editions from duplicate candidates and shows them again after restoration", async () => {
  const owner = "excluded-duplicates",
    s = createBookExclusionStore(f.db);
  const a = await imported(owner),
    b = await imported(owner, "book");
  await f.db.query(
    "UPDATE library_books SET isbn='9788936434267' WHERE owner_id=$1",
    [owner],
  );
  expect(
    (await bookDuplicateCandidates(f.db, owner, b.book.id)).candidates.map(
      (x) => x.id,
    ),
  ).toEqual([a.book.id]);
  await s.exclude(owner, { requestId: randomUUID(), items: [a.selection] });
  expect(
    (await bookDuplicateCandidates(f.db, owner, b.book.id)).candidates,
  ).toHaveLength(0);
  const entry = (await s.list(owner, {})).items[0];
  await s.restore(owner, {
    id: entry.id,
    expectedVersion: entry.version,
    requestId: randomUUID(),
  });
  expect(
    (await bookDuplicateCandidates(f.db, owner, b.book.id)).candidates.map(
      (x) => x.id,
    ),
  ).toEqual([a.book.id]);
});
it("includes retained records and exclusion state in exports/backups and restores them into a fresh library", async () => {
  const owner = "backup-excluded",
    s = createBookExclusionStore(f.db),
    a = await imported(owner);
  const l = createLibraryStore(f.db);
  await l.mutate(
    owner,
    op("addNote", {
      bookId: a.book.id,
      title: "개인 메모",
      content: "보관할 생각",
    }),
  );
  await s.exclude(owner, { requestId: randomUUID(), items: [a.selection] });
  expect((await l.snapshot(owner)).notes).toHaveLength(1);
  const exported = await l.exportLibrary(owner);
  expect(exported.library.books).toHaveLength(1);
  expect(exported.bookExclusions).toHaveLength(1);
  const backup = await createBackup(f.db, owner);
  expect(backup.tables.library_book_exclusions).toHaveLength(1);
  const target = await testDatabase();
  try {
    expect(
      (await inspectBackup(target.db, "restored-excluded", backup)).canRestore,
    ).toBe(true);
    await restoreBackup(target.db, "restored-excluded", backup);
    expect((await readBookPage(target.db, "restored-excluded", {})).total).toBe(
      0,
    );
    expect(
      (await createBookExclusionStore(target.db).list("restored-excluded", {}))
        .total,
    ).toBe(1);
  } finally {
    await target.pg.close();
  }
});
it("allows the restricted runtime to list and restore without broader DELETE privileges", async () => {
  const owner = "runtime-excluded",
    s = createBookExclusionStore(f.db),
    a = await imported(owner);
  await s.exclude(owner, { requestId: randomUUID(), items: [a.selection] });
  await f.pg.exec(
    await readFile("db/operations/provision-web-runtime.sql", "utf8"),
  );
  await f.pg.exec("SET SESSION AUTHORIZATION library_web_runtime");
  try {
    expect((await readCatalogCounts(f.db, owner)).total).toBe(0);
    const entry = (await s.list(owner, {})).items[0];
    await s.restore(owner, {
      id: entry.id,
      expectedVersion: entry.version,
      requestId: randomUUID(),
    });
    expect((await readCatalogCounts(f.db, owner)).total).toBe(1);
    await expect(f.pg.exec("DELETE FROM library_books")).rejects.toThrow();
  } finally {
    await f.pg.exec("RESET SESSION AUTHORIZATION");
  }
});
it("also removes excluded roots from connection judgments, topic membership, worker sources and auxiliary search", async () => {
  const owner = "excluded-knowledge",
    s = createBookExclusionStore(f.db),
    a = await imported(owner),
    b = await imported(owner, "book"),
    topic = randomUUID(),
    run = randomUUID();
  await f.db.query(
    "INSERT INTO library_topics(id,owner_id,name) VALUES($1,$2,'주제')",
    [topic, owner],
  );
  await f.db.query(
    "INSERT INTO library_topic_memberships(id,owner_id,topic_id,source_kind,source_id,source_version,status,method) VALUES($1,$2,$3,'book',$4,'1','accepted','manual')",
    [randomUUID(), owner, topic, a.book.id],
  );
  for (const [from, to] of [
    [a.book.id, b.book.id],
    [b.book.id, a.book.id],
  ])
    await f.db.query(
      "INSERT INTO library_connections(id,owner_id,source_kind,source_id,target_kind,target_id,relation,status,reason) VALUES($1,$2,'book',$3,'book',$4,'related','accepted','숨길 연결 판단')",
      [randomUUID(), owner, from, to],
    );
  await f.db.query(
    "INSERT INTO library_curation_runs(id,owner_id,scope_hash,executor) VALUES($1,$2,'test','test')",
    [run, owner],
  );
  await f.db.query(
    "INSERT INTO library_curation_items(id,owner_id,run_id,source_kind,source_id,source_version,kind,value,evidence,coverage,origin,generator,fingerprint) VALUES($1,$2,$3,'book',$4,'1','description','\"숨길 연결 판단\"','[]','metadata','rule','test','test')",
    [randomUUID(), owner, run, a.book.id],
  );
  await s.exclude(owner, { requestId: randomUUID(), items: [a.selection] });
  expect(
    (await createKnowledgeStore(f.db).snapshot(owner)).connections,
  ).toHaveLength(0);
  expect(
    (await createThoughtMapStore(f.db).snapshot(owner)).memberships,
  ).toHaveLength(0);
  expect(
    (
      await readSourcePage(f.db, owner, randomUUID(), { kind: "books" })
    ).items.map((x) => x.id),
  ).toEqual([b.book.id]);
  expect(
    (await searchLibrary(f.db, owner, { text: "숨길 연결 판단", layer: "all" }))
      .items,
  ).toHaveLength(0);
  expect(
    (
      await f.db.query(
        "SELECT id FROM library_active_documents WHERE owner_id=$1",
        [owner],
      )
    ).rows.map((x) => x.id),
  ).toEqual([b.doc.id]);
});
