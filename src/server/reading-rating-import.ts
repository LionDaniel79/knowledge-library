import { randomUUID } from "node:crypto";
import { mapLegacyReading } from "../lib/legacy-reading";
import { storedRating } from "../lib/reading-ratings";
import type { Book } from "../lib/domain";
import type { Database } from "./library-store";
import { LibraryError } from "./library-store";
import { withSyncWrite } from "./sync/write";
// Restore preserved import ratings only; never replace a user rating or cleared value.
export async function backfillImportedRatings(
  db: Database,
  owner: string,
  apply = false,
) {
  if (!owner) throw new LibraryError(401, "로그인이 필요합니다.");
  return withSyncWrite(db, owner, async (tx) => {
    const books = (
      await tx.query(
        `SELECT id,total_pages AS "totalPages",source_data AS "sourceData" FROM library_active_books WHERE owner_id=$1 AND source_data->>'app'='iReadItNow HD'`,
        [owner],
      )
    ).rows;
    const mapped = new Map(
      mapLegacyReading(books as Book[])
        .filter((c) => c.status === "completed")
        .map((c) => [c.sourceKey, c]),
    );
    const cycles = (
      await tx.query(
        `SELECT c.* FROM library_cycles c JOIN library_active_books b ON b.owner_id=c.owner_id AND b.id=c.book_id WHERE c.owner_id=$1 AND c.status='completed' AND b.source_data->>'app'='iReadItNow HD' ORDER BY c.book_id,c.completed_on DESC NULLS LAST,c.created_at DESC,c.id DESC FOR UPDATE OF c`,
        [owner],
      )
    ).rows;
    const latest = new Set<string>(),
      changes = [];
    for (const c of cycles) {
      const first = !latest.has(c.book_id);
      latest.add(c.book_id);
      if (c.source_data?.readingRating || !c.source_key) continue;
      const candidate = mapped.get(c.source_key),
        session =
          storedRating(c.source_data) ??
          storedRating({ raw: candidate?.sourceData.raw });
      // A book-level fallback belongs only to the latest completion, not every reread.
      const steps =
        session ??
        (first && candidate ? storedRating(candidate.sourceData) : null);
      if (steps == null) continue;
      changes.push({
        c,
        steps,
        origin: session == null ? "ireaditnow-book" : "ireaditnow-session",
      });
    }
    if (apply)
      for (const { c, steps, origin } of changes) {
        const next = (
          await tx.query(
            `UPDATE library_cycles SET source_data=coalesce(source_data,'{}'::jsonb)||jsonb_build_object('readingRating',jsonb_build_object('steps',$4::int,'origin',$5::text)),version=version+1 WHERE owner_id=$1 AND id=$2 AND version=$3 RETURNING *`,
            [owner, c.id, c.version, steps, origin],
          )
        ).rows[0];
        if (!next) throw new LibraryError(409, "독서 기록이 변경되었습니다.");
        await tx.query(
          `INSERT INTO library_revisions(id,owner_id,entity_id,action,before_data,after_data) VALUES($1,$2,$3,'importReadingRating',$4::jsonb,$5::jsonb)`,
          [randomUUID(), owner, c.id, JSON.stringify(c), JSON.stringify(next)],
        );
      }
    return {
      candidates: changes.length,
      applied: apply ? changes.length : 0,
      session: changes.filter((c) => c.origin === "ireaditnow-session").length,
      bookFallback: changes.filter((c) => c.origin === "ireaditnow-book")
        .length,
    };
  });
}
