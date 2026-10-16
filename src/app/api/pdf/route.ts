import { requireOwner } from "@/server/auth";
import { database } from "@/server/db";
import { failure } from "@/server/http";
import {
  pdfIndexSummary,
  searchPdfPages,
  withPdfIndex,
  pdfDocumentDetail,
} from "@/server/pdf-index";
import { z } from "zod";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const owner = await requireOwner();
    const params = new URL(request.url).searchParams;
    const mode = params.get("mode") ?? "list";
    const query = (params.get("q") ?? "").slice(0, 200);
    const id = params.get("id");
    if (id) z.string().uuid().parse(id);
    let result: unknown;
    if (mode === "search") {
      const hits = searchPdfPages(query, id ?? undefined);
      const owned = await database.query(
        'SELECT d.id,d.book_id AS "bookId",b.title,b.author FROM library_documents d JOIN library_books b ON b.owner_id=d.owner_id AND b.id=d.book_id WHERE d.owner_id=$1 AND d.id=ANY($2::uuid[])',
        [owner, hits.map((h) => h.documentId)],
      );
      const map = new Map(owned.rows.map((d) => [d.id, d]));
      result = {
        hits: hits
          .filter((h) => map.has(h.documentId))
          .map((h) => ({ ...h, ...map.get(h.documentId) })),
        summary: pdfIndexSummary(),
      };
    } else if (mode === "detail" && id) {
      const owned = (
        await database.query(
          'SELECT id,book_id AS "bookId",relative_path AS "relativePath" FROM library_documents WHERE owner_id=$1 AND id=$2',
          [owner, id],
        )
      ).rows[0];
      result = owned
        ? {
            ...owned,
            ...pdfDocumentDetail(id),
          }
        : null;
    } else {
      const page = Math.max(
        0,
        Math.min(10000, Number(params.get("page")) || 0),
      );
      const docs = await database.query(
        `SELECT d.id,d.book_id AS "bookId",b.title,b.author,d.relative_path AS "relativePath",d.bytes::float8 AS bytes,d.processing_scope AS "processingScope",d.material_kind AS "materialKind" FROM library_documents d JOIN library_books b ON b.owner_id=d.owner_id AND b.id=d.book_id WHERE d.owner_id=$1 AND ($2='' OR b.title ILIKE $3 OR d.relative_path ILIKE $3) ORDER BY b.title,d.id LIMIT 30 OFFSET $4`,
        [owner, query, "%" + query + "%", Math.floor(page) * 30],
      );
      const total = Number(
        await database
          .query(
            "SELECT count(*) n FROM library_documents d JOIN library_books b ON b.owner_id=d.owner_id AND b.id=d.book_id WHERE d.owner_id=$1 AND ($2='' OR b.title ILIKE $3 OR d.relative_path ILIKE $3)",
            [owner, query, "%" + query + "%"],
          )
          .then((r) => r.rows[0].n),
      );
      let summary = null;
      let states = new Map<string, Record<string, unknown>>();
      try {
        summary = pdfIndexSummary();
        states = withPdfIndex(
          (db) =>
            new Map(
              docs.rows.map((d) => [
                d.id,
                db
                  .prepare(
                    "SELECT CASE WHEN processing_scope='full' THEN status ELSE 'metadata_only' END AS status,page_count AS pageCount,CASE WHEN processing_scope='full' THEN indexed_pages ELSE 0 END AS indexedPages FROM documents WHERE id=?",
                  )
                  .get(d.id) ?? {},
              ]),
            ),
        );
      } catch {}
      result = {
        documents: docs.rows.map((d) => ({
          ...d,
          ...(d.processingScope === "metadata_only"
            ? { status: "metadata_only", indexedPages: 0 }
            : {}),
          ...states.get(d.id),
        })),
        total,
        page,
        summary,
      };
    }
    return Response.json(result, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (e) {
    return failure(e);
  }
}
