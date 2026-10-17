import { syncQuery } from "../../server/sync/write";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { catalogPrecheck } from "../../lib/catalog-precheck";
import { decideCatalogReview } from "../../server/catalog-review-store";
import { LibraryError, type Database } from "../../server/library-store";

/** Operator/collector only. HTTP decisions always use the human review path. */
export async function precheckCatalogReviews(
  db: Database,
  owner: string,
  apply = false,
  bookId?: string,
) {
  if (!owner) throw new LibraryError(401, "로그인이 필요합니다.");
  const rows = (
    await db.query(
      `SELECT r.id,r.book_id,r.version,r.source_version,r.decision,b.version AS current_version,b.title,b.author,b.publisher,b.isbn,r.record->'facts' AS facts
    FROM library_catalog_reviews r JOIN library_active_books b ON b.owner_id=r.owner_id AND b.id=r.book_id
    WHERE r.owner_id=$1 AND r.status='pending' AND ($2::uuid IS NULL OR b.id=$2)
    AND NOT EXISTS(SELECT 1 FROM library_documents d WHERE d.owner_id=b.owner_id AND d.book_id=b.id AND (d.processing_scope<>'full' OR d.material_kind~*'paper|periodical|journal|thesis'))
    AND(coalesce(b.source_data->>'app','')<>'Local PDF' OR EXISTS(SELECT 1 FROM library_documents d WHERE d.owner_id=b.owner_id AND d.book_id=b.id AND d.processing_scope='full'))
    ORDER BY b.id,r.created_at,r.id`,
      [owner, bookId ?? null],
    )
  ).rows;
  const annotations: any[] = [],
    certain = new Map<string, any>();
  for (const row of rows) {
    const proof = catalogPrecheck(
      {
        title: row.title,
        author: row.author,
        publisher: row.publisher,
        isbn: row.isbn,
      },
      row.facts,
    );
    if (row.current_version !== row.source_version) {
      proof.certain = false;
      proof.reasons.push("source_changed");
    }
    if (proof.certain && !certain.has(row.book_id))
      certain.set(row.book_id, row);
    if (!isDeepStrictEqual(row.decision?.precheck, proof))
      annotations.push({ id: row.id, version: row.version, proof });
  }
  const report = {
    examined: rows.length,
    books: new Set(rows.map((r) => r.book_id)).size,
    certain: certain.size,
    applied: 0,
    changed: 0,
  };
  if (!apply) return report;
  // Annotating changes the review version, so an already-open human form cannot silently apply stale information.
  for (let i = 0; i < annotations.length; i += 100)
    await syncQuery(
      db,
      owner,
      `UPDATE library_catalog_reviews r SET decision=coalesce(r.decision,'{}'::jsonb)||jsonb_build_object('precheck',x.proof),version=r.version+1,updated_at=now()
    FROM jsonb_to_recordset($2::jsonb) x(id uuid,version integer,proof jsonb) WHERE r.owner_id=$1 AND r.id=x.id AND r.version=x.version AND r.status='pending'`,
      [owner, JSON.stringify(annotations.slice(i, i + 100))],
    );
  const annotated = new Set(annotations.map((x) => x.id));
  for (const row of certain.values()) {
    try {
      await decideCatalogReview(
        db,
        owner,
        {
          id: row.id,
          expectedVersion: row.version + (annotated.has(row.id) ? 1 : 0),
          requestId: randomUUID(),
          action: "apply",
          fields: [],
          sameEdition: false,
        },
        "catalog_precheck",
      );
      report.applied++;
    } catch (e) {
      if (!(e instanceof LibraryError) || e.status !== 409) throw e;
      report.changed++;
    }
  }
  return report;
}
