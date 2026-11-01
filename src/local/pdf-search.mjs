import { pdfSearchTerms } from "./pdf-search-query.mjs";
export { pdfSearchTerms } from "./pdf-search-query.mjs";
/**
 * Read-only search shared by the web tests and the isolated Node process.
 * @returns {Array<{documentId: string, status: string, pageNumber: number, signature: string, extractionMethod: string, title: string, quote: string}>}
 */
export function searchPdfRows(db, query, documentId) {
  const terms = pdfSearchTerms(query);
  if (
    !db
      .prepare("PRAGMA table_info(documents)")
      .all()
      .some((r) => r.name === "processing_scope")
  )
    return [];
  const ftsTerms = terms.filter((term) => [...term].length >= 3);
  const useFts =
    ftsTerms.length > 0 &&
    Boolean(
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='pages_fts'",
        )
        .get(),
    );
  // SQLite lower() folds ASCII only. Non-ASCII cased text is verified in JS
  // instead of being incorrectly excluded by a short-term candidate filter.
  const literalTerms = (
    useFts ? terms.filter((term) => [...term].length < 3) : terms
  ).filter(
    (term) =>
      /^[\x00-\x7f]*$/.test(term) || term.toLowerCase() === term.toUpperCase(),
  );
  const filters = literalTerms.map(() => "instr(lower(p.text),lower(?))>0");
  const args = [];
  if (useFts) {
    filters.unshift("pages_fts MATCH ?");
    args.push(
      ftsTerms
        .map((term) => '"' + term.replaceAll('"', '""') + '"')
        .join(" AND "),
    );
  }
  args.push(...literalTerms);
  const where = filters.join(" AND ") || "1";
  if (documentId) args.push(documentId);
  // Ranking every match on a large external-drive index delays even the first
  // result. Stream FTS row IDs; for short terms, visit eligible books first.
  // CROSS JOIN keeps SQLite from scanning excluded papers before those books.
  const from = useFts
    ? "pages p JOIN documents d ON d.id=p.document_id JOIN pages_fts ON pages_fts.rowid=p.id"
    : "documents d CROSS JOIN pages p ON p.document_id=d.id";
  const sql = `SELECT p.document_id AS documentId,p.page_number AS pageNumber,p.text,p.method,d.signature,d.title,d.status FROM ${from} WHERE ${where} AND d.processing_scope='full' AND d.status NOT IN ('changed','error','locked') ${documentId ? "AND d.id=?" : ""} ${useFts ? "ORDER BY pages_fts.rowid" : ""}`;
  const foldedTerms = terms.map((term) => term.toLowerCase());
  const hits = [];
  for (const r of db.prepare(sql).iterate(...args)) {
    const text = String(r.text);
    const foldedText = text.toLowerCase();
    const positions = foldedTerms.map((term) => foldedText.indexOf(term));
    // FTS is a candidate index, including when its contents are stale. Verify
    // every literal clause against this page before counting the result limit.
    if (positions.some((position) => position < 0)) continue;
    const start = Math.max(
      0,
      (positions.length ? Math.min(...positions) : 0) - 100,
    );
    hits.push({
      documentId: String(r.documentId),
      status: String(r.status),
      pageNumber: Number(r.pageNumber),
      signature: String(r.signature),
      extractionMethod: String(r.method),
      title: String(r.title),
      quote: text.slice(start, start + 900),
    });
    if (hits.length === 40) break;
  }
  return hits;
}
