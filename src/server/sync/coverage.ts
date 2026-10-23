import { syncEntities, type SyncEntity } from "../../lib/replica/entities";
import type { Database } from "../library-store";
import { syncHead, syncRead, syncSql, syncEntityAvailable } from "./registry";
import { createHash } from "node:crypto";
export interface SyncCoverage {
  epoch: string;
  head: string;
  entities: Record<SyncEntity, { rows: number; sha256: string }>;
}
export async function readSyncCoverage(
  db: Database,
  owner: string,
): Promise<SyncCoverage> {
  return syncRead(db, owner, async (tx) => {
    const head = await syncHead(tx, owner);
    const entities = {} as SyncCoverage["entities"];
    for (const name of Object.keys(syncEntities)) {
      if (!(await syncEntityAvailable(tx, name as SyncEntity))) {
        entities[name as SyncEntity] = {
          rows: 0,
          sha256: createHash("sha256").update("").digest("hex"),
        };
        continue;
      }
      const sql = syncSql(name as SyncEntity);
      const query = `SELECT count(*)::int AS rows,
    encode(sha256(convert_to(coalesce(string_agg(record_key||E'\\t'||value_hash||E'\\n','' ORDER BY record_key COLLATE "C"),''),'UTF8')),'hex') AS sha256
    FROM (SELECT ${sql.key} AS record_key,encode(sha256(convert_to((${sql.value})::text,'UTF8')),'hex') AS value_hash FROM ${sql.table} t WHERE owner_id=$1) values`;
      const row = (await tx.query(query, [owner])).rows[0];
      entities[name as SyncEntity] = {
        rows: Number(row.rows),
        sha256: String(row.sha256),
      };
    }
    return { epoch: head.epoch, head: head.head, entities };
  });
}
