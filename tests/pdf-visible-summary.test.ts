import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testDatabase } from "./helpers/database";
import { importPdfCatalog } from "../src/server/pdf-catalog-import";
import { createBookExclusionStore } from "../src/server/book-exclusions";
import { pdfIndexSummary } from "../src/server/pdf-index";
import { readVisiblePdfSummary } from "../src/server/pdf-visible-summary";
let f: Awaited<ReturnType<typeof testDatabase>>, dir: string;
const previous = process.env.LIBRARY_PDF_INDEX;
const documents = ["book", "paper", "review"].map((kind) => ({
  id: randomUUID(),
  root: "E:/전자도서관",
  path: `E:/전자도서관/${kind}.pdf`,
  relative_path: `${kind}.pdf`,
  title: kind,
  author: "저자",
  page_count: 10,
  bytes: 1024,
  mtime_ns: "123",
  processing_scope: kind === "book" ? "full" : "metadata_only",
  material_kind: kind,
  scope_reason: "검증",
  scope_version: "test",
}));
beforeAll(async () => {
  f = await testDatabase();
  dir = await mkdtemp(join(tmpdir(), "library-summary-test-"));
  process.env.LIBRARY_PDF_INDEX = join(dir, "index.sqlite");
  const index = new DatabaseSync(process.env.LIBRARY_PDF_INDEX);
  index.exec(
    "CREATE TABLE documents(id TEXT PRIMARY KEY,processing_scope TEXT,status TEXT,page_count INTEGER,indexed_pages INTEGER,text_pages INTEGER,sha256 TEXT); CREATE TABLE pages(id INTEGER PRIMARY KEY,document_id TEXT,method TEXT); CREATE INDEX pages_document_method ON pages(document_id,method);",
  );
  for (const d of documents) {
    index
      .prepare("INSERT INTO documents VALUES(?,?,'ready',10,2,2,'hash')")
      .run(d.id, d.processing_scope);
    index
      .prepare("INSERT INTO pages(document_id,method) VALUES(?,'text')")
      .run(d.id);
  }
  index.close();
});
afterAll(async () => {
  if (previous === undefined) delete process.env.LIBRARY_PDF_INDEX;
  else process.env.LIBRARY_PDF_INDEX = previous;
  await f?.pg.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});
it("filters excluded documents from total, basic-only, hash and page-method aggregates", () => {
  expect(pdfIndexSummary()).toMatchObject({
    total: 3,
    basicOnly: 2,
    hashes: { stored: 3, total: 3 },
    pageMethods: { text: 1 },
  });
  expect(pdfIndexSummary([documents[1].id])).toMatchObject({
    total: 2,
    basicOnly: 1,
    hashes: { stored: 2, total: 2 },
    pageMethods: { text: 1 },
  });
  expect(pdfIndexSummary([documents[0].id])).toMatchObject({
    total: 2,
    basicOnly: 2,
    hashes: { stored: 2, total: 2 },
    pages: 0,
    pageMethods: {},
  });
});
it("uses the owner exclusion state and invalidates cached IDs immediately after restore", async () => {
  const owner = randomUUID(),
    s = createBookExclusionStore(f.db);
  await importPdfCatalog(f.db, owner, documents);
  const book = (
    await f.db.query(
      "SELECT b.id,b.version FROM library_books b JOIN library_documents d ON d.owner_id=b.owner_id AND d.book_id=b.id WHERE d.owner_id=$1 AND d.id=$2",
      [owner, documents[1].id],
    )
  ).rows[0];
  expect((await readVisiblePdfSummary(f.db, owner)).total).toBe(3);
  await s.exclude(owner, {
    requestId: randomUUID(),
    items: [{ id: book.id, expectedVersion: book.version, kind: "paper" }],
  });
  expect(await readVisiblePdfSummary(f.db, owner)).toMatchObject({
    total: 2,
    basicOnly: 1,
    hashes: { total: 2, stored: 2 },
  });
  expect((await readVisiblePdfSummary(f.db, owner)).total).toBe(2);
  expect((await readVisiblePdfSummary(f.db, "different-owner")).total).toBe(3);
  const entry = (await s.list(owner, {})).items[0];
  await s.restore(owner, {
    id: entry.id,
    expectedVersion: entry.version,
    requestId: randomUUID(),
  });
  expect((await readVisiblePdfSummary(f.db, owner)).total).toBe(3);
});
