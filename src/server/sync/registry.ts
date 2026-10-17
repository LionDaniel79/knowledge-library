import { z } from "zod";
import { syncEntity, syncKeyInput } from "../../lib/replica/contracts";
import { entityDefinition, type SyncEntity } from "../../lib/replica/entities";
import { LibraryError, type Database, type Executor } from "../library-store";

export function syncInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new LibraryError(400, "동기화 요청을 확인해 주세요.");
  return result.data;
}
export function syncOwner(owner: string) {
  if (!owner || owner.length > 128)
    throw new LibraryError(401, "로그인이 필요합니다.");
}
const identifier = (name: string) => '"' + name + '"';
export function syncSql(entity: SyncEntity) {
  syncInput(syncEntity, entity);
  const def = entityDefinition(entity);
  const key = def.keys.length
    ? "'['||" +
      def.keys
        .map((k) => `to_jsonb(t.${identifier(k)}::text)::text`)
        .join("||','||") +
      "||']'"
    : "'[]'";
  const value =
    "jsonb_build_object(" +
    def.columns.map((k) => `'${k}',t.${identifier(k)}`).join(",") +
    ")";
  return { table: "public." + identifier(entity), key, value };
}
export function validateSyncKey(entity: SyncEntity, key: string) {
  syncInput(syncKeyInput, key);
  if (JSON.parse(key).length !== entityDefinition(entity).keys.length)
    throw new LibraryError(400, "자료 식별자를 확인해 주세요.");
}
export async function syncRead<T>(
  db: Database,
  owner: string,
  fn: (tx: Executor) => Promise<T>,
): Promise<T> {
  syncOwner(owner);
  return db.transaction(async (tx) => {
    await tx.query(
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
    );
    await tx.query("SET LOCAL TIME ZONE 'UTC'");
    return fn(tx);
  });
}
export async function syncHead(tx: Executor, owner: string) {
  const row = (
    await tx.query(
      "SELECT epoch::text,revision::text AS head,floor_revision::text AS floor FROM public.library_sync_heads WHERE owner_id=$1",
      [owner],
    )
  ).rows[0];
  return row
    ? {
        epoch: String(row.epoch),
        head: String(row.head),
        floor: String(row.floor),
      }
    : { epoch: "00000000-0000-4000-8000-000000000000", head: "0", floor: "0" };
}
