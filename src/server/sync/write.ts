import type { Database, Executor } from "../library-store";
import { LibraryError } from "../library-store";
const activeOwners = new WeakMap<Executor, string>();
export async function lockSyncOwner(
  tx: Executor,
  owner: string,
): Promise<void> {
  if (!owner || owner.length > 128)
    throw new LibraryError(401, "로그인이 필요합니다.");
  await tx.query("SELECT public.library_sync_lock($1)", [owner]);
}
export async function withSyncWrite<T>(
  db: Database,
  owner: string,
  fn: (tx: Executor) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.transaction(async (tx) => {
        const parentOwner = activeOwners.get(tx);
        if (parentOwner) {
          if (parentOwner !== owner)
            throw new LibraryError(403, "동기화 계정이 다릅니다.");
          return fn(tx);
        }
        await lockSyncOwner(tx, owner);
        activeOwners.set(tx, owner);
        try {
          return await fn(tx);
        } finally {
          activeOwners.delete(tx);
        }
      });
    } catch (error) {
      if (
        attempt >= 2 ||
        !["40001", "40P01"].includes(String((error as { code?: string })?.code))
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}
export async function syncQuery(
  db: Executor,
  owner: string,
  sql: string,
  params: unknown[] = [],
) {
  if (typeof (db as Database).transaction === "function")
    return withSyncWrite(db as Database, owner, (tx) => tx.query(sql, params));
  const locked = activeOwners.get(db);
  if (locked && locked !== owner)
    throw new LibraryError(403, "동기화 계정이 다릅니다.");
  if (!locked) {
    await lockSyncOwner(db, owner);
    // An unbranded Executor is allowed only on an already open transaction.
    // A pool/autocommit wrapper releases the lock before this next query.
    const current = await db.query(
      "SELECT pg_current_xact_id_if_assigned()::text AS xid",
    );
    if (!current.rows[0]?.xid)
      throw Error("동기화 쓰기에는 거래를 지원하는 저장소가 필요합니다.");
  }
  return db.query(sql, params);
}
