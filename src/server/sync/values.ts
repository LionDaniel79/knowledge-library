import { z } from "zod";
import {
  syncEntity,
  syncKeyInput,
  syncRevision,
  syncRow,
  VALUE_PART_BYTES,
  MAX_JSON_RESPONSE_BYTES,
  type SyncRow,
} from "../../lib/replica/contracts";
import type { SyncEntity } from "../../lib/replica/entities";
import { LibraryError, type Database, type Executor } from "../library-store";
import { syncInput, syncRead, syncSql, validateSyncKey } from "./registry";
// Batch typical cover images with the scan page. Large originals still use
// bounded value parts; the SQL running byte budget keeps every page <=512KiB.
const INLINE_BYTES = 128 * 1024;
export async function selectSyncRows(
  tx: Executor,
  owner: string,
  entity: SyncEntity,
  input: { after?: string; keys?: string[]; limit: number; bounded?: boolean },
) {
  const sql = syncSql(entity);
  const where = input.keys
    ? `${sql.key}=ANY($2::text[])`
    : `${sql.key} COLLATE "C">$2 COLLATE "C"`;
  const result = await tx.query(
    `WITH selected AS MATERIALIZED (
  SELECT ${sql.key} AS record_key,convert_to((${sql.value})::text,'UTF8') AS raw,
   coalesce(v.revision,0)::text AS revision
  FROM ${sql.table} t LEFT JOIN public.library_sync_row_versions v
   ON v.owner_id=t.owner_id AND v.entity='${entity}' AND v.record_key=${sql.key}
  WHERE t.owner_id=$1 AND ${where} ORDER BY ${sql.key} COLLATE "C" LIMIT $3
 ), described AS (
  SELECT record_key,jsonb_build_object('entity','${entity}','key',record_key,'revision',revision,'deleted',false,
   'sha256',encode(sha256(raw),'hex'),'bytes',octet_length(raw)) ||
   CASE WHEN octet_length(raw)<=${INLINE_BYTES} THEN jsonb_build_object('inline',convert_from(raw,'UTF8'))
   ELSE jsonb_build_object('parts',(SELECT jsonb_agg(jsonb_build_object('index',i,'bytes',octet_length(part),'sha256',encode(sha256(part),'hex')) ORDER BY i)
    FROM generate_series(0,(octet_length(raw)-1)/${VALUE_PART_BYTES}) i
    CROSS JOIN LATERAL (SELECT substring(raw FROM i*${VALUE_PART_BYTES}+1 FOR ${VALUE_PART_BYTES}) AS part) p)) END AS entry
  FROM selected
 ), bounded AS (
  SELECT entry,row_number() OVER(ORDER BY record_key COLLATE "C") AS pos,
   sum(octet_length(entry::text)+8) OVER(ORDER BY record_key COLLATE "C") AS total_bytes FROM described
 ) SELECT entry FROM bounded ${input.bounded ? "WHERE total_bytes<=" + String(MAX_JSON_RESPONSE_BYTES - 16384) + " OR pos=1" : ""} ORDER BY pos`,
    [owner, input.keys ?? input.after ?? "", input.limit],
  );
  return result.rows.map((r) => syncRow.parse(r.entry));
}
const partInput = z
  .object({
    entity: syncEntity,
    key: syncKeyInput,
    revision: syncRevision,
    index: z.number().int().min(0).max(5999),
  })
  .strict();
export async function readSyncValuePart(
  db: Database,
  owner: string,
  input: z.input<typeof partInput>,
): Promise<Uint8Array> {
  const v = syncInput(partInput, input);
  validateSyncKey(v.entity, v.key);
  return syncRead(db, owner, async (tx) => {
    const sql = syncSql(v.entity);
    const row = (
      await tx.query(
        `WITH value AS MATERIALIZED (
   SELECT convert_to((${sql.value})::text,'UTF8') AS raw,coalesce(v.revision,0)::text AS revision
   FROM ${sql.table} t LEFT JOIN public.library_sync_row_versions v
   ON v.owner_id=t.owner_id AND v.entity='${v.entity}' AND v.record_key=${sql.key}
   WHERE t.owner_id=$1 AND ${sql.key}=$2
  ) SELECT revision,octet_length(raw) AS bytes,substring(raw FROM $3::int+1 FOR ${VALUE_PART_BYTES}) AS part FROM value`,
        [owner, v.key, v.index * VALUE_PART_BYTES],
      )
    ).rows[0];
    if (!row) throw new LibraryError(404, "자료를 찾을 수 없습니다.");
    if (String(row.revision) !== v.revision)
      throw new LibraryError(409, "자료가 변경되었습니다. 다시 받아 주세요.");
    if (v.index * VALUE_PART_BYTES >= Number(row.bytes))
      throw new LibraryError(400, "자료 조각 번호를 확인해 주세요.");
    return new Uint8Array(row.part);
  });
}
export function assertSyncResponse(value: unknown) {
  if (
    Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_JSON_RESPONSE_BYTES
  )
    throw new LibraryError(413, "동기화 응답 크기를 초과했습니다.");
}
export function tombstone(
  entity: SyncEntity,
  key: string,
  revision: string,
): SyncRow {
  return { entity, key, revision, deleted: true, sha256: null, bytes: 0 };
}
