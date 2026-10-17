import type { Database, Executor } from "../library-store";
import { LibraryError } from "../library-store";
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
        await lockSyncOwner(tx, owner);
        return fn(tx);
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
