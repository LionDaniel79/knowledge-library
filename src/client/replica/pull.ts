import { parseSyncCursor, type SyncRow } from "../../lib/replica/contracts";
import type { ReplicaGeneration, ReplicaStorage } from "./storage";
import { SyncHttpError, type SyncTransport, type SyncMeta } from "./transport";
import { checkSyncAbort } from "./values";
import { prepareReplicaPage } from "./bootstrap";
export async function pullReplica(input: {
  owner: string;
  storage: ReplicaStorage;
  transport: SyncTransport;
  signal?: AbortSignal;
  meta?: SyncMeta;
  onProgress?: (rows: number, bytes: number) => void;
}): Promise<ReplicaGeneration> {
  const { owner, storage, transport, signal } = input;
  if (storage.owner !== owner) throw Error("서재 계정이 다릅니다.");
  const current = await storage.checkpoint();
  if (!current?.complete) throw Error("전체 자료를 먼저 내려받아 주세요.");
  let state: ReplicaGeneration = current;
  const meta = input.meta ?? (await transport.meta(false, signal));
  if (meta.epoch !== state.epoch)
    throw new SyncHttpError(409, "자료 세대가 변경되었습니다.");
  if (
    BigInt(parseSyncCursor(state.cursor, owner, state.epoch).after) <
    BigInt(meta.floor)
  )
    throw new SyncHttpError(410, "기기 자료를 다시 구성해야 합니다.");
  let retries = 0;
  for (let pages = 0; pages < 1000; pages++) {
    checkSyncAbort(signal);
    try {
      const page = await transport.changes(state.epoch, state.cursor, signal);
      if (page.epoch !== state.epoch)
        throw new SyncHttpError(409, "자료 세대가 변경되었습니다.");
      const before = parseSyncCursor(state.cursor, owner, state.epoch),
        next = parseSyncCursor(page.cursor, owner, state.epoch);
      if (
        next.entity ||
        BigInt(next.after) < BigInt(before.after) ||
        BigInt(next.after) > BigInt(page.head) ||
        (page.hasMore && next.after === before.after)
      )
        throw Error("변경분의 진행 위치가 올바르지 않습니다.");
      const latest = new Map<string, SyncRow>();
      for (const row of page.rows) {
        if (BigInt(row.revision) > BigInt(page.head))
          throw Error("확정되지 않은 자료가 포함됐습니다.");
        const key = row.entity + "\0" + row.key,
          old = latest.get(key);
        if (!old || BigInt(row.revision) > BigInt(old.revision))
          latest.set(key, row);
        else if (
          row.revision === old.revision &&
          (row.sha256 !== old.sha256 || row.deleted !== old.deleted)
        )
          throw Error("같은 순번의 내용이 다릅니다.");
      }
      const rows: SyncRow[] = [];
      let countDelta = 0,
        byteDelta = 0;
      for (const row of latest.values()) {
        const old = await storage.readRow(
          row.entity,
          row.key,
          state.generation,
        );
        if (old && BigInt(old.revision) > BigInt(row.revision)) continue;
        if (old?.revision === row.revision) {
          if (old.sha256 !== row.sha256 || old.deleted !== row.deleted)
            throw Error("같은 순번의 내용이 다릅니다.");
          continue;
        }
        rows.push(row);
        countDelta += (row.deleted ? 0 : 1) - (old && !old.deleted ? 1 : 0);
        byteDelta += row.bytes - (old?.bytes ?? 0);
      }
      await prepareReplicaPage(
        storage,
        state.generation,
        rows,
        transport,
        signal,
      );
      const patch: Pick<
        ReplicaGeneration,
        "cursor" | "rows" | "bytes" | "lastSyncedAt"
      > = {
        cursor: page.cursor,
        rows: state.rows + countDelta,
        bytes: state.bytes + byteDelta,
        lastSyncedAt: new Date().toISOString(),
      };
      await storage.transaction((tx) => {
        tx.stageRows(state!.generation, rows);
        tx.setCheckpoint(state!.generation, patch);
      });
      state = { ...state, ...patch };
      input.onProgress?.(state.rows, state.bytes);
      retries = 0;
      if (!page.hasMore) return state;
    } catch (error) {
      if (
        !(error instanceof SyncHttpError) ||
        error.status !== 409 ||
        retries++ >= 3
      )
        throw error;
    }
  }
  throw Error("변경분을 나눠 받고 있습니다. 다시 동기화하면 이어서 받습니다.");
}
