import { it, expect, afterAll } from "vitest";
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
