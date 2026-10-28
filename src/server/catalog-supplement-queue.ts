import { createHash, randomUUID } from "node:crypto";
import { isbn13 } from "../lib/bibliography";
import type { Database, Executor } from "./library-store";
import { withSyncWrite } from "./sync/write";
import { bookSelect } from "./book-records";
export const catalogCollectorScope = (email: string) =>
  createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
export async function enqueueCatalogSupplement(
  tx: Executor,
  owner: string,
  book: any,
  before?: any,
) {
  const changed =
    !before ||
    ["title", "author", "publisher", "isbn"].some((k) => book[k] !== before[k]);
  if (!changed) return book;
  const isbn = isbn13(book.isbn);
  if (!isbn) return book;
  const work = {
    state: "pending",
    isbn,
    owner,
    scope: catalogCollectorScope(process.env.LIBRARY_OWNER_EMAIL ?? ""),
    token: randomUUID(),
    attempts: 0,
    nextAttemptAt: 0,
  };
  const r = await tx.query(
    "UPDATE library_books SET enrichment=enrichment||jsonb_build_object('catalogSupplement',$3::jsonb) WHERE owner_id=$1 AND id=$2 RETURNING enrichment",
    [owner, book.id, JSON.stringify(work)],
  );
  return { ...book, enrichment: r.rows[0].enrichment };
}
export async function claimCatalogSupplement(
  db: Database,
  owner: string,
  id: string,
  scope: string,
  now = Date.now(),
) {
  return withSyncWrite(db, owner, async (tx) => {
    const b = (
      await tx.query(
        `SELECT ${bookSelect} FROM library_books WHERE owner_id=$1 AND id=$2 AND NOT EXISTS(SELECT 1 FROM library_book_exclusions e WHERE e.owner_id=$1 AND e.id=$2 AND e.state='excluded') FOR UPDATE`,
        [owner, id],
      )
    ).rows[0];
    const work = b?.enrichment?.catalogSupplement;
    if (
      !work ||
      work.owner !== owner ||
      work.scope !== scope ||
      work.state !== "pending" ||
      work.nextAttemptAt > now ||
      work.isbn !== isbn13(b.isbn)
    )
      return null;
    const enrichment = {
      ...b.enrichment,
      catalogSupplement: { ...work, nextAttemptAt: now + 300000 },
    };
    await tx.query(
      "UPDATE library_books SET enrichment=$3 WHERE owner_id=$1 AND id=$2",
      [owner, id, JSON.stringify(enrichment)],
    );
    return { ...b, enrichment };
  });
}
