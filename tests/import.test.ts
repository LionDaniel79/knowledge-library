import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { createLibraryStore, type Database } from "../src/server/library-store";
import { createImportStore } from "../src/server/import-store";
import { createLegacyReadingStore } from "../src/server/legacy-reading-store";
let pg: PGlite;
let db: Database;
const bundle = {
  schemaVersion: 1,
  source: "iReadItNowHD",
  sourceLibraryId: "sample-library",
  databaseSha256: "a".repeat(64),
  timezone: "Asia/Seoul",
  originalTables: { ZBOOK: [{ ZSTATUS: 32 }] },
  books: [
    {
      sourceId: "book-1",
      title: "전자책",
      author: "저자",
      formats: ["ebook"],
      sourceCreatedAt: null,
      sourceData: {
        app: "iReadItNow HD",
        libraryId: "sample-library",
        recordId: "book-1",
        statusCode: 32,
        originalFormat: "전자책",
        raw: { ZSTATUS: 32 },
        sessions: [
          {
            sourceId: "s1",
            statusCode: 3,
            startedOn: "2020-01-01",
            endedOn: "2020-01-03",
            bookmarks: [{ sourceId: "p1", page: 10, recordedAt: null }],
            raw: {},
          },
        ],
      },
    },
  ],
  notes: [
    {
      sourceId: "review:1",
      bookSourceId: "book-1",
      title: "서평",
      content: "나의 서평",
      kind: "review",
      page: null,
      sourceCreatedAt: null,
      sourceData: {
        app: "iReadItNow HD",
        libraryId: "sample-library",
        recordId: "1",
        raw: {},
      },
    },
  ],
};
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(await readFile("db/001_library.sql", "utf8"));
  await pg.exec(await readFile("db/002_ireaditnow.sql", "utf8"));
  await pg.exec(await readFile("db/003_reading_history.sql", "utf8"));
  await pg.exec(await readFile("db/004_pdf_library.sql", "utf8"));
  await pg.exec(await readFile("db/005_knowledge.sql", "utf8"));
  await pg.exec(await readFile("db/006_catalog.sql", "utf8"));
  await pg.exec(await readFile("db/007_thought_map.sql", "utf8"));
  await pg.exec(await readFile("db/008_thought_jobs.sql", "utf8"));
  await pg.exec(await readFile("db/009_analysis_devices.sql", "utf8"));
  await pg.exec(await readFile("db/010_library_ai_policy.sql", "utf8"));
  await pg.exec(await readFile("db/011_library_curation.sql", "utf8"));
  await pg.exec(await readFile("db/012_library_assist.sql", "utf8"));
  await pg.exec(await readFile("db/013_pdf_processing_scope.sql", "utf8"));
  await pg.exec(await readFile("db/015_book_relations.sql", "utf8"));
  await pg.exec(await readFile("db/016_research_organization.sql", "utf8"));
  await pg.exec(await readFile("db/017_note_trash.sql", "utf8"));
  await pg.exec(await readFile("db/025_book_exclusions.sql", "utf8"));
  await pg.exec(await readFile("db/026_device_sync.sql", "utf8"));
  db = {
    query: (s, p = []) => pg.query(s, p),
    transaction: (fn) =>
      pg.transaction((tx) => fn({ query: (s, p = []) => tx.query(s, p) })),
  };
});
afterAll(async () => {
  await pg?.close();
});
it("maps confirmed sessions once, preserves date edits and isolates owners", async () => {
  const completed = structuredClone(bundle);
  completed.books[0].sourceData.sessions[0].statusCode = 2;
  await createImportStore(db).apply("history", completed);
  const store = createLegacyReadingStore(db);
  expect(await store.run("history", true)).toMatchObject({
    completed: 1,
    reading: 0,
    added: 1,
  });
  await pg.query(
    "UPDATE library_cycles SET completed_on='2020-01-05',version=2 WHERE owner_id='history'",
  );
  expect(await store.run("history", true)).toMatchObject({ added: 0 });
  expect(
    (await createLibraryStore(db).snapshot("history")).cycles[0].completedOn,
  ).toBe("2020-01-05");
  expect(
    (await createLibraryStore(db).snapshot("unrelated")).cycles,
  ).toHaveLength(0);
});
it("imports owned ebooks and reviews atomically without inventing completed cycles", async () => {
  const result = await createImportStore(db).apply("one", bundle);
  expect(result).toMatchObject({ addedBooks: 1, addedNotes: 1 });
  const data = await createLibraryStore(db).snapshot("one");
  expect(data.books[0].formats).toEqual(["ebook"]);
  expect(data.notes[0]).toMatchObject({
    bookId: data.books[0].id,
    content: "나의 서평",
    kind: "review",
  });
  expect(data.books[0].sourceData?.sessions?.[0].statusCode).toBe(3);
  expect(data.cycles).toHaveLength(0);
});
it("reimport never duplicates or overwrites an edited note and separates owners", async () => {
  const importer = createImportStore(db);
  await importer.apply("repeat", bundle);
  await pg.query(
    "UPDATE library_notes SET content='수정한 서평',version=2 WHERE owner_id='repeat'",
  );
  expect(await importer.apply("repeat", bundle)).toMatchObject({
    addedBooks: 0,
    addedNotes: 0,
  });
  expect(
    (await createLibraryStore(db).snapshot("repeat")).notes[0].content,
  ).toBe("수정한 서평");
  await importer.apply("another", bundle);
  expect(
    (await createLibraryStore(db).snapshot("another")).notes[0].content,
  ).toBe("나의 서평");
  const exported = await createLibraryStore(db).exportLibrary("repeat");
  expect(exported.imports).toHaveLength(1);
  expect(JSON.stringify(exported.imports)).toContain("ZSTATUS");
  expect(exported.revisions).toHaveLength(2);
});
it("rejects orphan notes and duplicate source IDs before persisting anything", async () => {
  const broken = structuredClone(bundle);
  broken.notes[0].bookSourceId = "missing";
  await expect(
    createImportStore(db).apply("invalid", broken),
  ).rejects.toThrow();
  expect((await createLibraryStore(db).snapshot("invalid")).books).toHaveLength(
    0,
  );
  const duplicate = structuredClone(bundle);
  duplicate.books.push(duplicate.books[0]);
  await expect(
    createImportStore(db).apply("invalid", duplicate),
  ).rejects.toThrow();
  await expect(createImportStore(db).apply("", bundle)).rejects.toThrow();
});
