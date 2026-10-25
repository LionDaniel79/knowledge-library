import { z } from "zod";
import { syncEntities, type SyncEntity } from "../../lib/replica/entities";
import {
  createSyncCursor,
  parseSyncCursor,
  syncEntity,
  SYNC_PROTOCOL,
  type SyncPage,
} from "../../lib/replica/contracts";
import { LibraryError, type Database } from "../library-store";
import {
  syncHead,
  syncInput,
  syncRead,
  syncSql,
  syncEntityAvailable,
} from "./registry";
import { assertSyncResponse, selectSyncRows } from "./values";
import { selectSyncChangePage } from "./change-values";
const count = z.number().int().min(1).max(200).default(50);
const scanInput = z
  .object({
    entity: syncEntity,
    after: z.string().max(8192).optional(),
    limit: count,
  })
  .strict();
const changesInput = z
  .object({
    epoch: z.string().uuid(),
    cursor: z.string().min(1).max(8192),
    limit: count,
  })
  .strict();
function cursor(value: string, owner: string, epoch: string) {
  try {
    return parseSyncCursor(value, owner, epoch);
  } catch {
    throw new LibraryError(400, "동기화 위치를 확인해 주세요.");
  }
}
export async function readSyncMeta(
  db: Database,
  owner: string,
  inventory = true,
) {
  return syncRead(db, owner, async (tx) => {
    const head = await syncHead(tx, owner);
    const entities: Record<string, { rows: number; bytes: number }> = {};
    if (inventory) {
      for (const name of Object.keys(syncEntities)) {
        if (!(await syncEntityAvailable(tx, name as SyncEntity))) {
          entities[name] = { rows: 0, bytes: 0 };
          continue;
        }
        const sql = syncSql(name as SyncEntity);
        const r = (
          await tx.query(
            `SELECT count(*)::int AS rows,coalesce(sum(octet_length((${sql.value})::text)),0)::text AS bytes FROM ${sql.table} t WHERE owner_id=$1`,
            [owner],
          )
        ).rows[0];
        entities[name] = { rows: Number(r.rows), bytes: Number(r.bytes) };
      }
    }
    return {
      ...head,
      protocol: SYNC_PROTOCOL,
      entities,
      totalRows: Object.values(entities).reduce((n, e) => n + e.rows, 0),
      totalBytes: Object.values(entities).reduce((n, e) => n + e.bytes, 0),
    };
  });
}
export async function scanSyncRows(
  db: Database,
  owner: string,
  input: z.input<typeof scanInput>,
): Promise<SyncPage> {
  const v = syncInput(scanInput, input);
  return syncRead(db, owner, async (tx) => {
    const head = await syncHead(tx, owner),
      position = v.after ? cursor(v.after, owner, head.epoch) : undefined;
    if (
      position &&
      (position.entity !== v.entity || position.key === undefined)
    )
      throw new LibraryError(400, "자료의 이어받기 위치가 다릅니다.");
    if (!(await syncEntityAvailable(tx, v.entity)))
      return {
        epoch: head.epoch,
        head: head.head,
        cursor: createSyncCursor({
          owner,
          epoch: head.epoch,
          after: position?.after ?? head.head,
          entity: v.entity,
          key: position?.key,
        }),
        rows: [],
        hasMore: false,
      };
    const rows = await selectSyncRows(tx, owner, v.entity, {
      after: position?.key,
      limit: v.limit,
      bounded: true,
    });
    const key = rows.at(-1)?.key ?? position?.key ?? "";
    const sql = syncSql(v.entity);
    const hasMore = Boolean(
      (
        await tx.query(
          `SELECT 1 FROM ${sql.table} t WHERE owner_id=$1 AND ${sql.key} COLLATE "C">$2 COLLATE "C" LIMIT 1`,
          [owner, key],
        )
      ).rows.length,
    );
    const page = {
      epoch: head.epoch,
      head: head.head,
      cursor: createSyncCursor({
        owner,
        epoch: head.epoch,
        after: position?.after ?? head.head,
        entity: v.entity,
        key: key || undefined,
      }),
      rows,
      hasMore,
    };
    assertSyncResponse(page);
    return page;
  });
}
export async function readSyncChanges(
  db: Database,
  owner: string,
  input: z.input<typeof changesInput>,
): Promise<SyncPage> {
  const v = syncInput(changesInput, input);
  return syncRead(db, owner, async (tx) => {
    const head = await syncHead(tx, owner);
    if (v.epoch !== head.epoch)
      throw new LibraryError(
        409,
        "자료 세대가 변경되었습니다. 다시 동기화해 주세요.",
      );
    const position = cursor(v.cursor, owner, head.epoch);
    if (position.entity)
      throw new LibraryError(400, "변경분 위치를 확인해 주세요.");
    if (BigInt(position.after) < BigInt(head.floor))
      throw new LibraryError(410, "오래된 기기 자료를 다시 구성해야 합니다.");
    if (BigInt(position.after) > BigInt(head.head))
      throw new LibraryError(400, "동기화 순번을 확인해 주세요.");
    const events = (
      await tx.query(
        "SELECT c.entity,c.record_key,c.revision::text FROM public.library_sync_changes c WHERE c.owner_id=$1 AND c.revision>$2::bigint ORDER BY c.revision LIMIT $3",
        [owner, position.after, v.limit],
      )
    ).rows;
    const { rows, after } = events.length
      ? await selectSyncChangePage(
          tx,
          owner,
          events as { entity: string; record_key: string; revision: string }[],
        )
      : { rows: [], after: position.after };
    const page = {
      epoch: head.epoch,
      head: head.head,
      cursor: createSyncCursor({ owner, epoch: head.epoch, after }),
      rows,
      hasMore: BigInt(after) < BigInt(head.head),
    };
    assertSyncResponse(page);
    return page;
  });
}
