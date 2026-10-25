import type { Executor } from "./library-store";
/** Keep the active-book filter while locking only the writable base row. */
export async function readActiveBook(
  db: Executor,
  owner: string,
  id: string,
  lock = false,
) {
  return (
    await db.query(
      `SELECT b.* FROM library_books b WHERE b.owner_id=$1 AND b.id=$2 AND NOT EXISTS (SELECT 1 FROM library_book_exclusions e WHERE e.owner_id=b.owner_id AND e.id=b.id AND e.state='excluded')${lock ? " FOR UPDATE OF b" : ""}`,
      [owner, id],
    )
  ).rows[0];
}
