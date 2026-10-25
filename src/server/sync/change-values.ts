import {
  MAX_JSON_RESPONSE_BYTES,
  syncEntity,
  syncRow,
} from "../../lib/replica/contracts";
import { LibraryError, type Executor } from "../library-store";
import { syncInput, syncSql } from "./registry";
import { syncValueEntrySql } from "./values";

interface ChangeEvent {
  entity: string;
  record_key: string;
  revision: string;
}

/** Bound values on the DB side, in event order, before any large rows cross the wire. */
export async function selectSyncChangePage(
  tx: Executor,
  owner: string,
  events: ChangeEvent[],
) {
  const entities = [
    ...new Set(events.map((e) => syncInput(syncEntity, e.entity))),
  ];
  if (!entities.length)
    throw new LibraryError(409, "변경된 자료를 다시 확인해야 합니다.");
  const projections = entities.map((entity) => {
    const sql = syncSql(entity);
    return `SELECT e.entity,e.record_key,e.first_revision,
      coalesce(v.revision,0)::text AS revision,coalesce(v.deleted,false) AS deleted,
      CASE WHEN t.owner_id IS NOT NULL AND NOT coalesce(v.deleted,false)
        THEN convert_to((${sql.value})::text,'UTF8') END AS raw
     FROM event_keys e
     LEFT JOIN ${sql.table} t ON t.owner_id=$1 AND ${sql.key}=e.record_key
     LEFT JOIN public.library_sync_row_versions v ON v.owner_id=$1
       AND v.entity=e.entity AND v.record_key=e.record_key
     WHERE e.entity='${entity}'`;
  });
  const result = await tx.query(
    `WITH events AS MATERIALIZED (
      SELECT entity,record_key,revision::bigint AS event_revision
      FROM jsonb_to_recordset($2::jsonb) e(entity text,record_key text,revision text)
     ), event_keys AS MATERIALIZED (
      SELECT entity,record_key,min(event_revision) AS first_revision
      FROM events GROUP BY entity,record_key
     ), records AS MATERIALIZED (
      ${projections.join("\nUNION ALL\n")}
     ), described AS MATERIALIZED (
      SELECT first_revision,${syncValueEntrySql()} AS entry FROM records
     ), budgeted AS MATERIALIZED (
      SELECT entry,first_revision,row_number() OVER(ORDER BY first_revision) AS pos,
       sum(coalesce(octet_length(entry::text),4)+32) OVER(ORDER BY first_revision) AS bytes
      FROM described
     ), boundary AS (
      SELECT min(first_revision) AS next_revision FROM budgeted WHERE bytes>$3 AND pos>1
     )
     SELECT entry,(SELECT max(event_revision)::text FROM events
       WHERE boundary.next_revision IS NULL OR event_revision<boundary.next_revision) AS after
     FROM budgeted CROSS JOIN boundary WHERE bytes<=$3 OR pos=1 ORDER BY first_revision`,
    [owner, JSON.stringify(events), MAX_JSON_RESPONSE_BYTES - 16384],
  );
  if (!result.rows.length || result.rows.some((r) => !r.entry))
    throw new LibraryError(409, "변경된 자료를 다시 확인해야 합니다.");
  return {
    rows: result.rows.map((r) => syncRow.parse(r.entry)),
    // This is an event prefix, NOT the maximum revision of the current values.
    // A value can already contain a later edit without consuming intervening keys.
    after: String(result.rows[0].after),
  };
}
