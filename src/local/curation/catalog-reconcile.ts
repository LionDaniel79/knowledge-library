import { randomUUID } from "node:crypto";
import { isbn13 } from "../../lib/bibliography";
import { catalogEditionProof } from "../../lib/catalog-supplement";
import { collectedReviewSchema } from "../../lib/catalog-review";
import { bookSelect } from "../../server/book-records";
import { withSyncWrite } from "../../server/sync/write";
import { mirrorCover } from "../../server/cover-mirrors";
import type { Database } from "../../server/library-store";
import { supplementBook, libraryCorroborates } from "./catalog-supplement";
import type { CollectedBook } from "./catalog";
/** Reversible operator cleanup. Copies are never merged, and private records are untouched. */
export async function reconcileCatalogReviews(
  db: Database,
  owner: string,
  apply = false,
  storeCover = mirrorCover,
  maxErrors = Infinity,
  bookId?: string,
  corroboratingRecords: CollectedBook[] = [],
) {
  if (!owner) throw Error("Owner required.");
  const rows = (
    await db.query(
      `SELECT r.id,r.book_id,r.version,r.source_version,r.record->'facts' facts,r.record->>'isbn' candidate_isbn,jsonb_array_length(coalesce(r.record->'toc','[]')) toc_count,b.title,b.author,b.publisher,b.isbn,b.version current_version
 FROM library_catalog_reviews r JOIN library_active_books b ON b.owner_id=r.owner_id AND b.id=r.book_id
 WHERE r.owner_id=$1 AND r.status IN ('pending','deferred') AND($2::uuid IS NULL OR b.id=$2)
 AND NOT EXISTS(SELECT 1 FROM library_documents d WHERE d.owner_id=b.owner_id AND d.book_id=b.id AND(d.processing_scope<>'full' OR d.material_kind~*'paper|periodical|journal|thesis'))
 AND(coalesce(b.source_data->>'app','')<>'Local PDF' OR EXISTS(SELECT 1 FROM library_documents d WHERE d.owner_id=b.owner_id AND d.book_id=b.id)) ORDER BY b.id,r.id`,
      [owner, bookId ?? null],
    )
  ).rows;
  const byBook = new Map<string, any[]>();
  for (const r of rows)
    byBook.set(r.book_id, [...(byBook.get(r.book_id) ?? []), r]);
  const report = {
    examined: rows.length,
    books: byBook.size,
    resolvedBooks: 0,
    superseded: 0,
    remainingBooks: 0,
    failed: 0,
    errorCodes: {} as Record<string, number>,
  };
  for (const [id, choices] of byBook) {
    const proof = (book: any, facts: any) =>
      catalogEditionProof(
        book,
        facts,
        libraryCorroborates(book, corroboratingRecords),
      );
    const ranked = [...choices].sort((a, b) => {
      const score = (r: any) =>
        (proof(r, r.facts).certain ? 1000 : 0) +
        (r.facts.coverUrl ? 100 : 0) +
        Math.min(r.toc_count, 50) +
        (r.source_version === r.current_version ? 10 : 0);
      return score(b) - score(a) || a.id.localeCompare(b.id);
    });
    const winner = ranked.find((r) => proof(r, r.facts).certain);
    if (winner) {
      if (!apply) {
        report.resolvedBooks++;
        continue;
      }
      try {
        const book: any = (
          await db.query(
            `SELECT ${bookSelect} FROM library_active_books WHERE owner_id=$1 AND id=$2`,
            [owner, id],
          )
        ).rows[0];
        if (!book || book.version !== winner.current_version) {
          report.failed++;
          continue;
        }
        const full = (
          await db.query(
            "SELECT record FROM library_catalog_reviews WHERE owner_id=$1 AND book_id=$2 AND status IN ('pending','deferred') AND record->>'isbn'=$3 ORDER BY (coalesce(record->'facts'->>'coverUrl','')<>'') DESC,jsonb_array_length(coalesce(record->'toc','[]')) DESC LIMIT 30",
            [owner, id, winner.candidate_isbn],
          )
        ).rows;
        const records = full
          .map((r) => collectedReviewSchema.parse(r.record))
          .filter((r) => proof(book, r.facts).certain);
        const result = await supplementBook(
          db,
          owner,
          book,
          [...records, ...corroboratingRecords],
          false,
          storeCover,
        );
        if (!["complete"].includes(result.state)) {
          report.failed++;
          report.errorCodes[result.state] =
            (report.errorCodes[result.state] ?? 0) + 1;
          if (report.failed >= maxErrors) break;
          continue;
        }
        await withSyncWrite(db, owner, async (tx) => {
          const updated = await tx.query(
            `UPDATE library_catalog_reviews SET status=CASE WHEN id=$3 THEN 'applied' ELSE 'superseded' END,decision=coalesce(decision,'{}')||$4::jsonb,decision_request_id=$5,version=version+1,updated_at=now() WHERE owner_id=$1 AND book_id=$2 AND id=ANY($6::uuid[]) AND status IN ('pending','deferred') RETURNING id`,
            [
              owner,
              id,
              winner.id,
              JSON.stringify({
                reviewedBy: "isbn_reconciliation",
                precheck: proof(book, winner.facts),
                reason: "confirmed_owned_isbn",
              }),
              randomUUID(),
              choices.map((c) => c.id),
            ],
          );
          report.superseded += Math.max(0, updated.rows.length - 1);
        });
        report.resolvedBooks++;
      } catch (error) {
        report.failed++;
        const raw = String(
          (error as { code?: string }).code ?? (error as Error).name,
        );
        const table =
          /permission denied for (?:table|function) (library_[a-z_]+)/.exec(
            (error as Error).message,
          )?.[1];
        const code =
          (/^[A-Za-z0-9_]{1,40}$/.test(raw) ? raw : "PROCESSING_ERROR") +
          (table ? ":" + table : "");
        report.errorCodes[code] = (report.errorCodes[code] ?? 0) + 1;
        if (report.failed >= maxErrors) break;
      }
    } else {
      report.remainingBooks++;
      const unique = new Set<string>(),
        duplicates: any[] = [];
      for (const row of ranked) {
        const key = isbn13(row.candidate_isbn);
        if (!key) continue;
        if (unique.has(key)) duplicates.push(row);
        else unique.add(key);
      }
      if (apply && duplicates.length)
        await withSyncWrite(db, owner, async (tx) => {
          const r = await tx.query(
            "UPDATE library_catalog_reviews SET status='superseded',decision=coalesce(decision,'{}')||'{\"reviewedBy\":\"isbn_reconciliation\",\"reason\":\"duplicate_isbn_candidate\"}'::jsonb,version=version+1,updated_at=now() WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND status IN ('pending','deferred') RETURNING id",
            [owner, duplicates.map((d) => d.id)],
          );
          report.superseded += r.rows.length;
        });
      else if (!apply) report.superseded += duplicates.length;
    }
  }
  return report;
}
