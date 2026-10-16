import type { Executor } from "./library-store";
/** Lock the writable base row, not the SELECT-only public view. */
export async function readActiveNote(
  db: Executor,
  owner: string,
  id: string,
  lock = false,
) {
  return (
    await db.query(
      `SELECT n.* FROM library_notes n WHERE n.owner_id=$1 AND n.id=$2 AND NOT EXISTS (SELECT 1 FROM library_note_trash t WHERE t.owner_id=n.owner_id AND t.id=n.id AND t.restored_at IS NULL)${lock ? " FOR UPDATE OF n" : ""}`,
      [owner, id],
    )
  ).rows[0];
}
