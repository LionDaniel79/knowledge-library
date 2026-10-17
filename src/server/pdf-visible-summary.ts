import type { Database } from "./library-store";
import { pdfIndexSummary, withPdfIndex } from "./pdf-index";

// Only the small signature crosses the network on unchanged page requests.
// The signature includes document IDs and exclusion versions, so restores and
// importer remapping invalidate the list without waiting for a time-to-live.
const cache = new Map<string, { signature: string; ids: string[] }>();
export async function readVisiblePdfSummary(db: Database, owner: string) {
  withPdfIndex(() => undefined);
  const ids = await db.transaction(async (tx) => {
    await tx.query(
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
    );
    const signature = String(
      (
        await tx.query(
          `SELECT md5(coalesce(string_agg(d.id::text || ':' || e.version::text, ',' ORDER BY d.id),'')) AS signature
       FROM library_documents d JOIN library_book_exclusions e ON e.owner_id=d.owner_id AND e.id=d.book_id AND e.state='excluded'
       WHERE d.owner_id=$1`,
          [owner],
        )
      ).rows[0].signature,
    );
    const existing = cache.get(owner);
    if (existing?.signature === signature) return existing.ids;
    const ids = (
      await tx.query(
        `SELECT d.id FROM library_documents d JOIN library_book_exclusions e ON e.owner_id=d.owner_id AND e.id=d.book_id AND e.state='excluded' WHERE d.owner_id=$1 ORDER BY d.id`,
        [owner],
      )
    ).rows.map((row) => String(row.id));
    if (cache.size >= 10) cache.delete(cache.keys().next().value!);
    cache.set(owner, { signature, ids });
    return ids;
  });
  return pdfIndexSummary(ids);
}
