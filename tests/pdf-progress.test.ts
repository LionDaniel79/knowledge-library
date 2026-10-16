import { it, expect, afterAll } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pdfIndexSummary } from "../src/server/pdf-index";
const dir = mkdtempSync(join(tmpdir(), "pdf-progress-"));
const file = join(dir, "index.sqlite"),
  previous = process.env.LIBRARY_PDF_INDEX;
const db = new DatabaseSync(file);
db.exec(`CREATE TABLE documents(id TEXT PRIMARY KEY,status TEXT,processing_scope TEXT,indexed_pages INTEGER,text_pages INTEGER,page_count INTEGER,sha256 TEXT);
CREATE TABLE pages(id INTEGER PRIMARY KEY,document_id TEXT,method TEXT);
CREATE INDEX pages_document_method ON pages(document_id,method);
INSERT INTO documents VALUES ('book','partial_ocr','full',6,3,6,'hash'),('paper','metadata_only','metadata_only',1,1,1,NULL);
INSERT INTO pages VALUES (1,'book','text'),(2,'book','text'),(3,'book','ocr_unverified'),(4,'book','ocr_empty'),(5,'book','ocr_error'),(6,'book','needs_ocr'),(7,'paper','text');`);
db.close();
afterAll(() => {
  if (previous === undefined) delete process.env.LIBRARY_PDF_INDEX;
  else process.env.LIBRARY_PDF_INDEX = previous;
  rmSync(dir, { recursive: true, force: true });
});
it("counts OCR text separately from empty, error and pending, excluding basic-only material", () => {
  process.env.LIBRARY_PDF_INDEX = file;
  expect(pdfIndexSummary()).toMatchObject({
    total: 2,
    basicOnly: 1,
    knownPages: 6,
    hashes: { stored: 1, total: 2 },
    pageMethods: {
      text: 2,
      ocr_unverified: 1,
      ocr_empty: 1,
      ocr_error: 1,
      needs_ocr: 1,
    },
  });
});
it("marks stale workers unknown instead of claiming they are running; rejects malformed states", () => {
  process.env.LIBRARY_PDF_INDEX = file;
  const state = {
    version: 1,
    kind: "ocr",
    status: "running",
    counts: { processed: 7 },
    updatedAt: new Date(Date.now() - 300_000).toISOString(),
    pid: process.pid,
  };
  writeFileSync(join(dir, "index.ocr-status.json"), JSON.stringify(state));
  expect(pdfIndexSummary().workers.ocr).toMatchObject({ status: "stale" });
  writeFileSync(
    join(dir, "index.ocr-status.json"),
    JSON.stringify({ ...state, updatedAt: new Date().toISOString() }),
  );
  expect(pdfIndexSummary().workers.ocr).toMatchObject({ status: "running" });
  writeFileSync(
    join(dir, "index.ocr-status.json"),
    JSON.stringify({ ...state, status: "paused", reason: "low_disk" }),
  );
  expect(pdfIndexSummary().workers.ocr).toMatchObject({
    status: "paused",
    reason: "low_disk",
  });
  writeFileSync(join(dir, "index.ocr-status.json"), "{");
  expect(pdfIndexSummary().workers.ocr.status).toBe("unknown");
});
it("excludes changed, locked and error pages from searchable totals and reports them separately", () => {
  process.env.LIBRARY_PDF_INDEX = file;
  const changed = new DatabaseSync(file);
  changed.exec(`INSERT INTO documents VALUES ('changed','changed','full',1,1,1,NULL),('locked','locked','full',1,1,1,NULL),('error','error','full',1,1,1,NULL);
    INSERT INTO pages VALUES (8,'changed','text'),(9,'locked','ocr_unverified'),(10,'error','text');`);
  changed.close();
  expect(pdfIndexSummary()).toMatchObject({
    textPages: 3,
    unavailablePages: 3,
    pageMethods: { text: 2, ocr_unverified: 1 },
  });
});
it("avoids a full page-text scan on old indexes without the compact progress index", () => {
  process.env.LIBRARY_PDF_INDEX = file;
  const old = new DatabaseSync(file);
  old.exec("DROP INDEX pages_document_method");
  old.close();
  expect(pdfIndexSummary().pageMethods).toBeNull();
});
