import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { LibraryError } from "./library-store";
import { pdfWorkerStatus } from "./pdf-job-status";
import { searchPdfRows } from "../local/pdf-search.mjs";
import { validatePdfSearchQuery } from "./pdf-search";
export function withPdfIndex<T>(fn: (db: DatabaseSync) => T): T {
  const path = process.env.LIBRARY_PDF_INDEX;
  if (!path || !existsSync(path))
    throw new LibraryError(503, "이 컴퓨터의 PDF 색인이 연결되지 않았습니다.");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=5000");
    return fn(db);
  } finally {
    db.close();
  }
}
// Old indexes have not been scoped yet. Fail closed until the local scope pass runs.
export function fullPdfScope(db: DatabaseSync, alias = "d") {
  if (!/^[a-z]+$/.test(alias)) throw new Error("Invalid table alias");
  return db
    .prepare("PRAGMA table_info(documents)")
    .all()
    .some((r) => r.name === "processing_scope")
    ? `${alias}.processing_scope='full'`
    : "0";
}
export function pdfDocumentDetail(id: string) {
  return withPdfIndex((db) => {
    const row = db.prepare("SELECT * FROM documents WHERE id=?").get(id);
    if (!row) return null;
    const full = row.processing_scope === "full";
    return {
      pageCount: row.page_count,
      indexedPages: full ? row.indexed_pages : 0,
      textPages: full ? row.text_pages : 0,
      status: full ? row.status : "metadata_only",
      processingScope: full ? "full" : "metadata_only",
      materialKind: row.material_kind ?? "review",
      scopeReason: row.scope_reason ?? "범위 확인 대기",
      metadata: row.metadata,
      toc: full ? row.toc : "[]",
      sha256: row.sha256,
    };
  });
}
function searchablePdfScope(db: DatabaseSync) {
  return `${fullPdfScope(db)} AND d.status NOT IN ('changed','error','locked')`;
}
export function pdfIndexSummary(excludedDocumentIds: string[] = []) {
  return withPdfIndex((db) => {
    const visible = "d.id NOT IN (SELECT value FROM json_each(?))";
    const excluded = JSON.stringify(excludedDocumentIds);
    // One narrow aggregate also keeps older indexes usable without rereading large TOCs.
    const groups = db
      .prepare(
        `SELECT CASE WHEN ${fullPdfScope(db)} THEN 1 ELSE 0 END AS full,
      status,count(*) AS total,coalesce(sum(page_count),0) AS knownPages,
      coalesce(sum(indexed_pages),0) AS pages,coalesce(sum(text_pages),0) AS textPages,
      count(sha256) AS hashes FROM documents d WHERE ${visible} GROUP BY full,status`,
      )
      .all(excluded);
    let total = 0,
      basicOnly = 0,
      knownPages = 0,
      pages = 0,
      textPages = 0,
      unavailablePages = 0,
      stored = 0;
    const states: Record<string, number> = {};
    for (const group of groups) {
      const status = String(group.status),
        count = Number(group.total);
      total += count;
      if (!["changed", "missing"].includes(status))
        stored += Number(group.hashes);
      if (!group.full) {
        basicOnly += count;
        continue;
      }
      states[status] = count;
      knownPages += Number(group.knownPages);
      pages += Number(group.pages);
      if (["changed", "error", "locked"].includes(status))
        unavailablePages += Number(group.pages);
      else textPages += Number(group.textPages);
    }
    const pageMethods = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='index' AND name='pages_document_method'",
      )
      .get()
      ? Object.fromEntries(
          db
            .prepare(
              `SELECT p.method,count(*) n FROM documents d JOIN pages p INDEXED BY pages_document_method ON p.document_id=d.id WHERE ${searchablePdfScope(db)} AND ${visible} GROUP BY p.method`,
            )
            .all(excluded)
            .map((r) => [String(r.method), Number(r.n)]),
        )
      : null;
    return {
      total,
      basicOnly,
      knownPages,
      pages,
      textPages,
      unavailablePages,
      states,
      pageMethods,
      hashes: { stored, total },
      workers: {
        ocr: pdfWorkerStatus(process.env.LIBRARY_PDF_INDEX!, "ocr"),
        hash: pdfWorkerStatus(process.env.LIBRARY_PDF_INDEX!, "hash"),
      },
    };
  });
}
export function searchPdfPages(query: string, documentId?: string) {
  validatePdfSearchQuery(query);
  return withPdfIndex((db) => searchPdfRows(db, query, documentId));
}
export function readPdfPage(id: string, page: number) {
  return withPdfIndex((db) => {
    if (
      !db
        .prepare(
          `SELECT id FROM documents d WHERE id=? AND ${fullPdfScope(db)}`,
        )
        .get(id)
    )
      throw new LibraryError(
        409,
        "기본정보만 보관하는 자료는 본문 검색·분석에서 제외됩니다.",
      );
    return db
      .prepare(
        "SELECT p.text,p.method,d.signature,d.status,d.path,d.root,d.bytes,d.mtime_ns FROM pages p JOIN documents d ON d.id=p.document_id WHERE p.document_id=? AND p.page_number=?",
      )
      .get(id, page);
  });
}
