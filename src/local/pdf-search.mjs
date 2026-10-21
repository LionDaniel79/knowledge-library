export function pdfSearchTerms(query) {
  const terms = query.trim().split(/\s+/).filter(Boolean).slice(0, 8);
  if (
    !terms.length ||
    query.length > 200 ||
    terms.some((t) => [...t].length < 2)
  )
    throw Error("검색어를 두 글자 이상 입력해 주세요.");
  return terms;
}
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
  const useFts = terms.every((t) => [...t].length >= 3);
  const where = useFts
    ? "pages_fts MATCH ?"
    : terms.map(() => "instr(lower(p.text),lower(?))>0").join(" AND ");
  const args = useFts
    ? [terms.map((t) => '"' + t.replaceAll('"', '""') + '"').join(" AND ")]
    : [...terms];
  if (documentId) args.push(documentId);
  // Ranking every match on a large external-drive index delays even the first
  // result. Stream FTS row IDs; for short terms, visit eligible books first.
  // CROSS JOIN keeps SQLite from scanning excluded papers before those books.
  const from = useFts
    ? "pages p JOIN documents d ON d.id=p.document_id JOIN pages_fts ON pages_fts.rowid=p.id"
    : "documents d CROSS JOIN pages p ON p.document_id=d.id";
  const sql = `SELECT p.document_id AS documentId,p.page_number AS pageNumber,p.text,p.method,d.signature,d.title,d.status FROM ${from} WHERE ${where} AND d.processing_scope='full' AND d.status NOT IN ('changed','error','locked') ${documentId ? "AND d.id=?" : ""} ${useFts ? "ORDER BY pages_fts.rowid" : ""} LIMIT 40`;
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
}
