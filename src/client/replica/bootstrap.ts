import { Sha256Stream } from "../../lib/replica/codec";
import { syncEntities, type SyncEntity } from "../../lib/replica/entities";
import {
  createSyncCursor,
  parseSyncCursor,
  type SyncRow,
} from "../../lib/replica/contracts";
import type { ReplicaGeneration, ReplicaStorage } from "./storage";
import {
  SyncHttpError,
  type SyncTransport,
  type ReplicaCoverage,
} from "./transport";
import { checkSyncAbort, ensureReplicaValue } from "./values";
export interface DownloadProgress {
  phase: "downloading" | "checking" | "pulling" | "complete";
  rows: number;
  bytes: number;
  totalRows: number;
  totalBytes: number;
}
export async function localReplicaCoverage(
  storage: ReplicaStorage,
  generation: string,
  epoch: string,
  head: string,
  signal?: AbortSignal,
): Promise<ReplicaCoverage> {
  const entities = {} as ReplicaCoverage["entities"];
  for (const entity of Object.keys(syncEntities) as SyncEntity[]) {
    const hash = new Sha256Stream();
    let rows = 0,
      after: string | undefined;
    while (true) {
      checkSyncAbort(signal);
      const page = await storage.readPage(entity, {
        generation,
        after,
        limit: 200,
      });
      for (const row of page.rows)
        if (!row.deleted) {
          await ensureReplicaValue(storage, generation, row, undefined, signal);
          rows++;
          hash.update(
            new TextEncoder().encode(row.key + "\t" + row.sha256 + "\n"),
          );
        }
      after = page.after;
      if (!page.hasMore) break;
    }
    entities[entity] = { rows, sha256: hash.hex() };
  }
  return { epoch, head, entities };
}
export async function prepareReplicaPage(
  storage: ReplicaStorage,
  generation: string,
  rows: SyncRow[],
  transport: SyncTransport,
  signal?: AbortSignal,
) {
  // Process one record at a time; its part downloader owns the global limit of two.
  for (const row of rows) {
    checkSyncAbort(signal);
    await ensureReplicaValue(storage, generation, row, transport, signal);
  }
}
export async function bootstrapReplica(input: {
  owner: string;
  storage: ReplicaStorage;
  transport: SyncTransport;
  onProgress?: (p: DownloadProgress) => void;
  signal?: AbortSignal;
  fresh?: boolean;
}): Promise<ReplicaGeneration> {
  const { owner, storage, transport, signal } = input;
  if (storage.owner !== owner) throw Error("서재 계정이 다릅니다.");
  const meta = await transport.meta(true, signal);
  checkSyncAbort(signal);
  let pending: ReplicaGeneration | undefined;
  const activeGeneration = (await storage.checkpoint())?.generation ?? null;
  if (!input.fresh)
    pending = (await storage.listGenerations())
      .filter(
        (g) =>
          g.epoch === meta.epoch &&
          !g.complete &&
          (g.baseGeneration ?? null) === activeGeneration,
      )
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  if (pending) {
    const pos = parseSyncCursor(pending.startCursor, owner, meta.epoch);
    if (BigInt(pos.after) < BigInt(meta.floor)) pending = undefined;
  }
  let state: ReplicaGeneration =
    pending ??
    (await storage.createGeneration({
      epoch: meta.epoch,
      cursor: createSyncCursor({ owner, epoch: meta.epoch, after: meta.head }),
    }));
  const generation = state.generation;
  const progress = (phase: DownloadProgress["phase"]) =>
    input.onProgress?.({
      phase,
      rows: state!.rows,
      bytes: state!.bytes,
      totalRows: meta.totalRows,
      totalBytes: meta.totalBytes,
    });
  for (const entity of Object.keys(syncEntities) as SyncEntity[]) {
    if (state.scan[entity]?.done) continue;
    let after = state.scan[entity]?.after,
      retries = 0;
    while (true) {
      checkSyncAbort(signal);
      progress("downloading");
      try {
        const page = await transport.scan(entity, after, signal);
        if (page.epoch !== meta.epoch)
          throw new SyncHttpError(409, "자료 세대가 변경되었습니다.");
        const position = parseSyncCursor(page.cursor, owner, meta.epoch);
        if (position.entity !== entity)
          throw Error("다른 자료의 응답을 받았습니다.");
        await prepareReplicaPage(
          storage,
          generation,
          page.rows,
          transport,
          signal,
        );
        const previous = state.scan[entity];
        const scan: ReplicaGeneration["scan"] = {
          ...state.scan,
          [entity]: {
            after: page.cursor,
            done: !page.hasMore,
            rows: (previous?.rows ?? 0) + page.rows.length,
            bytes:
              (previous?.bytes ?? 0) +
              page.rows.reduce((n, r) => n + r.bytes, 0),
          },
        };
        const entityRevisions = { ...state.entityRevisions };
        entityRevisions[entity] = page.rows.reduce(
          (max, row) =>
            BigInt(row.revision) > BigInt(max) ? row.revision : max,
          entityRevisions[entity] ?? "0",
        );
        state = {
          ...state,
          entityRevisions,
          scan,
          rows: Object.values(scan).reduce((n, p) => n + (p.rows ?? 0), 0),
          bytes: Object.values(scan).reduce((n, p) => n + (p.bytes ?? 0), 0),
        };
        await storage.transaction((tx) => {
          tx.stageRows(generation, page.rows);
          tx.setCheckpoint(generation, {
            scan: state!.scan,
            rows: state!.rows,
            bytes: state!.bytes,
            entityRevisions: state!.entityRevisions,
          });
        });
        after = page.cursor;
        if (!page.hasMore) break;
      } catch (error) {
        if (
          !(error instanceof SyncHttpError) ||
          error.status !== 409 ||
          retries++ >= 3
        )
          throw error;
        after = undefined;
        state.scan = { ...state.scan, [entity]: { done: false } };
        await storage.setCheckpoint(generation, { scan: state.scan });
      }
    }
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    let retries = 0;
    while (true) {
      checkSyncAbort(signal);
      progress("pulling");
      try {
        const page = await transport.changes(meta.epoch, state.cursor, signal);
        if (page.epoch !== meta.epoch)
          throw new SyncHttpError(409, "자료 세대가 변경되었습니다.");
        const position = parseSyncCursor(page.cursor, owner, meta.epoch);
        if (position.entity) throw Error("변경분 응답을 확인해 주세요.");
        await prepareReplicaPage(
          storage,
          generation,
          page.rows,
          transport,
          signal,
        );
        const entityRevisions = { ...state.entityRevisions };
        for (const row of page.rows)
          if (BigInt(row.revision) > BigInt(entityRevisions[row.entity] ?? "0"))
            entityRevisions[row.entity] = row.revision;
        await storage.transaction((tx) => {
          tx.stageRows(generation, page.rows);
          tx.setCheckpoint(generation, {
            cursor: page.cursor,
            appliedRevision: position.after,
            entityRevisions,
          });
        });
        state.cursor = page.cursor;
        state.entityRevisions = entityRevisions;
        if (!page.hasMore) break;
      } catch (error) {
        if (
          !(error instanceof SyncHttpError) ||
          error.status !== 409 ||
          retries++ >= 3
        )
          throw error;
      }
    }
    const remote = await transport.coverage(signal),
      position = parseSyncCursor(state.cursor, owner, meta.epoch);
    if (remote.epoch !== meta.epoch)
      throw new SyncHttpError(409, "자료 세대가 변경되었습니다.");
    if (remote.head !== position.after) continue;
    progress("checking");
    const local = await localReplicaCoverage(
      storage,
      generation,
      meta.epoch,
      position.after,
      signal,
    );
    if (
      Object.keys(syncEntities).some((name) => {
        const entity = name as SyncEntity;
        return (
          local.entities[entity].rows !== remote.entities[entity].rows ||
          local.entities[entity].sha256 !== remote.entities[entity].sha256
        );
      })
    )
      throw Error(
        "전체 자료의 개수나 내용이 일치하지 않습니다. 다시 동기화해 주세요.",
      );
    state = {
      ...state,
      complete: true,
      appliedRevision: parseSyncCursor(state.cursor, owner, meta.epoch).after,
      lastSyncedAt: new Date().toISOString(),
      rows: Object.values(local.entities).reduce((n, e) => n + e.rows, 0),
    };
    await storage.transaction((tx) => {
      tx.setCheckpoint(generation, {
        complete: true,
        appliedRevision: state!.appliedRevision,
        lastSyncedAt: state!.lastSyncedAt,
        rows: state!.rows,
      });
      tx.promoteGeneration(generation);
    });
    progress("complete");
    return state;
  }
  throw Error("변경된 자료를 따라잡고 있습니다. 잠시 후 다시 동기화해 주세요.");
}
