import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { LibraryError } from "./library-store";
import { pdfWorkerStatus } from "./pdf-job-status";
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
export function pdfIndexSummary() {
  return withPdfIndex((db) => {
    // One narrow aggregate also keeps older indexes usable without rereading large TOCs.
    const groups = db
      .prepare(
        `SELECT CASE WHEN ${fullPdfScope(db)} THEN 1 ELSE 0 END AS full,
      status,count(*) AS total,coalesce(sum(page_count),0) AS knownPages,
      coalesce(sum(indexed_pages),0) AS pages,coalesce(sum(text_pages),0) AS textPages,
      count(sha256) AS hashes FROM documents d GROUP BY full,status`,
      )
      .all();
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
              `SELECT p.method,count(*) n FROM documents d JOIN pages p INDEXED BY pages_document_method ON p.document_id=d.id WHERE ${searchablePdfScope(db)} GROUP BY p.method`,
            )
            .all()
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
  const terms = query.trim().split(/\s+/).filter(Boolean).slice(0, 8);
  if (!terms.length || query.length > 200 || terms.some((t) => t.length < 2))
    throw new LibraryError(400, "검색어를 두 글자 이상 입력해 주세요.");
  return withPdfIndex((db) => {
    const useFts = terms.every((t) => [...t].length >= 3);
    const where = useFts
      ? "pages_fts MATCH ?"
      : terms.map(() => "instr(lower(p.text),lower(?))>0").join(" AND ");
    const args = useFts
      ? [terms.map((t) => '"' + t.replaceAll('"', '""') + '"').join(" AND ")]
      : terms;
    if (documentId) args.push(documentId);
    const sql = `SELECT p.document_id AS documentId,p.page_number AS pageNumber,p.text,p.method,d.signature,d.title,d.status FROM pages p JOIN documents d ON d.id=p.document_id ${useFts ? "JOIN pages_fts ON pages_fts.rowid=p.id" : ""} WHERE ${where} AND ${searchablePdfScope(db)} ${documentId ? "AND d.id=?" : ""} ORDER BY ${useFts ? "pages_fts.rank," : ""} p.document_id,p.page_number LIMIT 40`;
    return db
      .prepare(sql)
      .all(...args)
      .map((r) => {
        const text = String(r.text);
        const positions = terms
          .map((t) => text.toLocaleLowerCase().indexOf(t.toLocaleLowerCase()))
          .filter((n) => n >= 0);
        const start = Math.max(
          0,
          (positions.length ? Math.min(...positions) : 0) - 100,
        );
        return {
          documentId: String(r.documentId),
          status: String(r.status),
          pageNumber: Number(r.pageNumber),
          signature: String(r.signature),
          extractionMethod: String(r.method),
          title: String(r.title),
          quote: text.slice(start, start + 900),
        };
      });
  });
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
