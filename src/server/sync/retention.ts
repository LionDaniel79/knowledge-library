import type { Database } from "../library-store";
import { withSyncWrite } from "./write";
export const SYNC_RETENTION_DAYS = 180;
/** Operator maintenance only: intentionally not exposed through a web route. */
export async function pruneSyncChanges(
  db: Database,
  owner: string,
  options: { before?: Date },
): Promise<void> {
  const oldestAllowed = Date.now() - SYNC_RETENTION_DAYS * 86400000;
  const time = options.before
    ? Math.min(options.before.getTime(), oldestAllowed)
    : oldestAllowed;
  if (!Number.isFinite(time)) throw Error("보존 기간을 확인해 주세요.");
  await withSyncWrite(db, owner, async (tx) => {
    const head = (
      await tx.query(
        "SELECT revision::text,floor_revision::text FROM library_sync_heads WHERE owner_id=$1",
        [owner],
      )
    ).rows[0];
    const row = (
      await tx.query(
        "SELECT min(revision)::text AS first FROM library_sync_changes WHERE owner_id=$1 AND created_at >= $2",
        [owner, new Date(time)],
      )
    ).rows[0];
    const cutoff =
      row.first === null ? BigInt(head.revision) : BigInt(row.first) - 1n;
    if (cutoff <= BigInt(head.floor_revision)) return;
    await tx.query(
      "DELETE FROM library_sync_changes WHERE owner_id=$1 AND revision<=$2::bigint",
      [owner, cutoff.toString()],
    );
    await tx.query(
      "UPDATE library_sync_heads SET floor_revision=$2::bigint WHERE owner_id=$1",
      [owner, cutoff.toString()],
    );
  });
}
