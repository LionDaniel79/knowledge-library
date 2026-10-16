import { stat } from "node:fs/promises";
import { withPdfIndex, fullPdfScope } from "../../server/pdf-index";
import {
  resolvePdfPath,
  verifyCitationSignature,
} from "../../server/pdf-access";
import type {
  AnalysisRecord,
  ContextExcerpt,
} from "../../lib/thought-map/types";
import { ThoughtIndex, terms } from "./index";
export async function findPdfContext(
  index: ThoughtIndex,
  query: AnalysisRecord,
  bookIds: string[],
  limit: number,
): Promise<ContextExcerpt[]> {
  const root = process.env.LIBRARY_PDF_ROOT;
  if (!root) return [];
  const metadata = index
      .list()
      .filter(
        (d) =>
          d.source.kind === "book_metadata" && bookIds.includes(d.source.id),
      ),
    result: ContextExcerpt[] = [],
    words = terms(query.content)
      .filter((w) => Array.from(w).length >= 2)
      .slice(0, 6);
  if (!words.length) return [];
  for (const book of metadata) {
    if (result.length >= Math.min(4, limit)) break;
    let used = false;
    for (const id of book.pdfDocumentIds ?? []) {
      if (used) break;
      let rows: Record<string, any>[];
      try {
        rows = withPdfIndex((db) =>
          db
            .prepare(
              `SELECT p.page_number,p.text,d.signature,d.path,d.status FROM pages p JOIN documents d ON d.id=p.document_id WHERE d.id=? AND ${fullPdfScope(db)} AND p.method='text' AND d.status IN ('ready','partial_ocr','indexing','ocr_review') AND (${words.map(() => "instr(lower(p.text),lower(?))>0").join(" OR ")}) ORDER BY p.page_number LIMIT 6`,
            )
            .all(id, ...words),
        );
      } catch {
        continue;
      }
      for (const row of rows) {
        const key = `pdf:${id}:${row.page_number}`;
        try {
          const file = await resolvePdfPath(String(row.path), root),
            info = await stat(file, { bigint: true });
          verifyCitationSignature(
            String(row.signature),
            `${info.size}:${info.mtimeNs}`,
          );
          const text = String(row.text);
          if (!text.trim()) continue;
          const matches = words
            .map((w) => text.toLowerCase().indexOf(w.toLowerCase()))
            .filter((n) => n >= 0);
          let start = Math.max(0, Math.min(...matches) - 100);
          if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start])) start--;
          const quote = Array.from(text.slice(start)).slice(0, 800).join("");
          const source = {
            kind: "pdf" as const,
            id,
            version: String(row.signature),
            page: Number(row.page_number),
          };
          index.put({
            key,
            rootId: book.rootId,
            source,
            text: quote,
            hash: source.version,
            topicIds: book.topicIds,
            coverage: "partial",
            start,
            end: start + quote.length,
          });
          result.push({
            id: key,
            text: quote,
            source,
            coverage: "partial",
            verifiedLocally: true,
            verifiedAt: new Date().toISOString(),
            start,
            end: start + quote.length,
          });
          used = true;
          break;
        } catch {
          index.remove(key);
        }
      }
    }
  }
  return result;
}
