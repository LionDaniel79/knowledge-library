import { it, expect, afterAll, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchPdfPages, readPdfPage } from "../src/server/pdf-index";
const temp = await mkdtemp(join(tmpdir(), "library-index-test-")),
  file = join(temp, "index.sqlite"),
  previous = process.env.LIBRARY_PDF_INDEX;
const db = new DatabaseSync(file);
db.exec(
  `CREATE TABLE documents(id TEXT PRIMARY KEY,signature TEXT,title TEXT,status TEXT,processing_scope TEXT,path TEXT,root TEXT,bytes INTEGER,mtime_ns TEXT);CREATE TABLE pages(id INTEGER PRIMARY KEY,document_id TEXT,page_number INTEGER,text TEXT,method TEXT);INSERT INTO documents(id,signature,title,status,processing_scope) VALUES('doc','10:123','상담 자료','missing','full'),('paper','10:123','상담 논문','ready','metadata_only');INSERT INTO pages VALUES(1,'doc',7,'관계 속에서 상담은 서로의 이야기를 듣는 일이다.','text'),(2,'paper',1,'논문 속 상담 분석','text');`,
);
db.close();
afterAll(async () => {
  if (previous === undefined) delete process.env.LIBRARY_PDF_INDEX;
  else process.env.LIBRARY_PDF_INDEX = previous;
  await rm(temp, { recursive: true, force: true });
});
it("never exposes archived paper text through search or direct page reads", () => {
  process.env.LIBRARY_PDF_INDEX = file;
  expect(searchPdfPages("논문", "paper")).toEqual([]);
  expect(() => readPdfPage("paper", 1)).toThrow(/기본정보/);
});
it("keeps indexed quotations searchable when the external drive is disconnected", () => {
  process.env.LIBRARY_PDF_INDEX = file;
  expect(searchPdfPages("상담")).toMatchObject([
    {
      pageNumber: 7,
      quote: "관계 속에서 상담은 서로의 이야기를 듣는 일이다.",
      status: "missing",
    },
  ]);
});
it("streams FTS hits in page order without computing ranks for the entire match set", () => {
  process.env.LIBRARY_PDF_INDEX = file;
  const fixture = new DatabaseSync(file);
  fixture.exec(
    "CREATE VIRTUAL TABLE pages_fts USING fts5(text,content='pages',content_rowid='id',tokenize='trigram'); INSERT INTO pages_fts(pages_fts) VALUES('rebuild');",
  );
  const original = DatabaseSync.prototype.prepare;
  let captured = "";
  const spy = vi
    .spyOn(DatabaseSync.prototype, "prepare")
    .mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql.startsWith("SELECT p.document_id")) captured = sql;
      return original.call(this, sql);
    });
  try {
    expect(searchPdfPages("이야기를")).toMatchObject([
      { documentId: "doc", pageNumber: 7 },
    ]);
    const plan = fixture
      .prepare("EXPLAIN QUERY PLAN " + captured)
      .all('"이야기를"');
    expect(
      plan.some((r) => String(r.detail).includes("TEMP B-TREE FOR ORDER BY")),
    ).toBe(false);
    expect(captured).toContain("ORDER BY pages_fts.rowid");
    expect(searchPdfPages("이야기를", "paper")).toEqual([]);
  } finally {
    spy.mockRestore();
    fixture.close();
  }
});
it("streams two-character hits without sorting every matching page first", () => {
  process.env.LIBRARY_PDF_INDEX = file;
  const fixture = new DatabaseSync(file),
    original = DatabaseSync.prototype.prepare;
  fixture.exec(
    "CREATE INDEX documents_progress ON documents(processing_scope,status,id); CREATE INDEX pages_document ON pages(document_id,page_number)",
  );
  let captured = "";
  const spy = vi
    .spyOn(DatabaseSync.prototype, "prepare")
    .mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql.startsWith("SELECT p.document_id")) captured = sql;
      return original.call(this, sql);
    });
  try {
    expect(searchPdfPages("상담")).toHaveLength(1);
    const plan = fixture.prepare("EXPLAIN QUERY PLAN " + captured).all("상담");
    expect(
      plan.some((r) => String(r.detail).includes("TEMP B-TREE FOR ORDER BY")),
    ).toBe(false);
  } finally {
    spy.mockRestore();
    fixture.close();
  }
});
