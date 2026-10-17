import {
  syncRow,
  outboxEntry,
  type OutboxEntry,
  type ReplicaCheckpoint,
  type SyncRow,
} from "../../lib/replica/contracts";
import type { SyncEntity } from "../../lib/replica/entities";
export const replicaStores = [
  "meta",
  "rows",
  "parts",
  "indexes",
  "outbox",
  "conflicts",
] as const;
export type ReplicaStore = (typeof replicaStores)[number];
export type ReplicaKey = (string | number)[];
export interface StoredEntry {
  id: ReplicaKey;
  data: unknown;
}
export interface ReplicaIO {
  get(store: ReplicaStore, key: ReplicaKey): Promise<any>;
  put(store: ReplicaStore, key: ReplicaKey, data: unknown): Promise<void>;
  delete(store: ReplicaStore, key: ReplicaKey): Promise<void>;
}
export interface ReplicaBackend {
  get(store: ReplicaStore, key: ReplicaKey): Promise<any>;
  scan(
    store: ReplicaStore,
    prefix: ReplicaKey,
    after?: ReplicaKey,
    limit?: number,
  ): Promise<StoredEntry[]>;
  transaction(fn: (io: ReplicaIO) => Promise<void>): Promise<void>;
  close(): void;
}
export interface ReplicaGeneration extends ReplicaCheckpoint {
  startCursor: string;
  startedAt: string;
  scan: Partial<
    Record<
      SyncEntity,
      { after?: string; done: boolean; rows?: number; bytes?: number }
    >
  >;
  rows: number;
  bytes: number;
  lastSyncedAt: string | null;
}
export interface ReplicaConflict {
  requestId: string;
  entityId: string;
  local: unknown;
  base: unknown;
  server: unknown;
  createdAt: string;
}
type Patch = Partial<Omit<ReplicaGeneration, "owner" | "generation">>;
type Command =
  | { type: "init"; state: ReplicaGeneration }
  | { type: "rows"; generation: string; rows: SyncRow[] }
  | { type: "checkpoint"; generation: string; patch: Patch }
  | { type: "promote"; generation: string }
  | {
      type: "part";
      generation: string;
      row: SyncRow;
      index: number;
      bytes: Uint8Array;
    }
  | {
      type: "put";
      store: "outbox" | "conflicts" | "indexes";
      key: string;
      generation?: string;
      data: unknown;
    }
  | {
      type: "delete";
      store: "outbox" | "conflicts" | "indexes";
      key: string;
      generation?: string;
    };
export interface ReplicaWrite {
  stageRows(generation: string, rows: SyncRow[]): void;
  setCheckpoint(generation: string, patch: Patch): void;
  promoteGeneration(generation: string): void;
  putValuePart(
    generation: string,
    row: SyncRow,
    index: number,
    bytes: Uint8Array,
  ): void;
  putOutbox(entry: OutboxEntry): void;
  removeOutbox(requestId: string): void;
  putConflict(conflict: ReplicaConflict): void;
  removeConflict(requestId: string): void;
  putIndex(generation: string, key: string, value: unknown): void;
  removeIndex(generation: string, key: string): void;
}
export interface ReplicaStorage {
  readonly owner: string;
  createGeneration(input: {
    epoch: string;
    cursor: string;
  }): Promise<ReplicaGeneration>;
  checkpoint(generation?: string): Promise<ReplicaGeneration | null>;
  listGenerations(): Promise<ReplicaGeneration[]>;
  transaction(fn: (tx: ReplicaWrite) => unknown): Promise<void>;
  stageRows(generation: string, rows: SyncRow[]): Promise<void>;
  setCheckpoint(generation: string, patch: Patch): Promise<void>;
  promoteGeneration(generation: string): Promise<void>;
  readRow(
    entity: SyncEntity,
    key: string,
    generation?: string,
  ): Promise<SyncRow | undefined>;
  readPage(
    entity: SyncEntity,
    input?: { generation?: string; after?: string; limit?: number },
  ): Promise<{ rows: SyncRow[]; after?: string; hasMore: boolean }>;
  putValuePart(
    generation: string,
    row: SyncRow,
    index: number,
    bytes: Uint8Array,
  ): Promise<void>;
  readValuePart(
    generation: string,
    row: SyncRow,
    index: number,
  ): Promise<Uint8Array | undefined>;
  putOutbox(entry: OutboxEntry): Promise<void>;
  listOutbox(): Promise<OutboxEntry[]>;
  listConflicts(): Promise<ReplicaConflict[]>;
  readIndex(key: string, generation?: string): Promise<any>;
  close(): void;
}
export function createReplicaStorage(
  owner: string,
  backend: ReplicaBackend,
): ReplicaStorage {
  if (!owner || owner.length > 128) throw Error("서재 계정을 확인해 주세요.");
  let closed = false;
  const check = () => {
    if (closed) throw Error("서재 저장소를 다시 열어 주세요.");
  };
  const stateKey = (generation: string): ReplicaKey => [
    owner,
    "generation",
    generation,
  ];
  const partKey = (
    generation: string,
    row: SyncRow,
    index: number,
  ): ReplicaKey => [owner, generation, row.entity, row.key, row.sha256!, index];
  async function apply(commands: Command[]) {
    check();
    await backend.transaction(async (io) => {
      const state = async (generation: string): Promise<ReplicaGeneration> => {
        const s = await io.get("meta", stateKey(generation));
        if (!s) throw Error("저장 세대를 찾을 수 없습니다.");
        return s;
      };
      for (const command of commands)
        switch (command.type) {
          case "init":
            await io.put(
              "meta",
              stateKey(command.state.generation),
              command.state,
            );
            break;
          case "rows":
            await state(command.generation);
            for (const row of command.rows) {
              const key = [owner, command.generation, row.entity, row.key],
                old: SyncRow | undefined = await io.get("rows", key);
              if (!old || BigInt(row.revision) >= BigInt(old.revision))
                await io.put("rows", key, row);
            }
            break;
          case "checkpoint": {
            const s = await state(command.generation);
            await io.put("meta", stateKey(command.generation), {
              ...s,
              ...command.patch,
            });
            break;
          }
          case "promote": {
            const s = await state(command.generation);
            if (!s.complete)
              throw Error("전체 자료의 검증이 끝나지 않았습니다.");
            await io.put("meta", [owner, "active"], command.generation);
            break;
          }
          case "part":
            await state(command.generation);
            await io.put(
              "parts",
              partKey(command.generation, command.row, command.index),
              command.bytes,
            );
            break;
          case "put":
            if (command.generation) await state(command.generation);
            await io.put(
              command.store,
              command.generation
                ? [owner, command.generation, command.key]
                : [owner, command.key],
              command.data,
            );
            break;
          case "delete":
            await io.delete(
              command.store,
              command.generation
                ? [owner, command.generation, command.key]
                : [owner, command.key],
            );
            break;
        }
    });
  }
  async function transaction(fn: (tx: ReplicaWrite) => unknown) {
    check();
    const commands: Command[] = [];
    const writer: ReplicaWrite = {
      stageRows(generation, rows) {
        commands.push({
          type: "rows",
          generation,
          rows: rows.map((r) => syncRow.parse(r)),
        });
      },
      setCheckpoint(generation, patch) {
        if (Object.hasOwn(patch, "owner") || Object.hasOwn(patch, "generation"))
          throw Error("저장 계정과 세대는 변경할 수 없습니다.");
        commands.push({
          type: "checkpoint",
          generation,
          patch: structuredClone(patch),
        });
      },
      promoteGeneration(generation) {
        commands.push({ type: "promote", generation });
      },
      putValuePart(generation, row, index, bytes) {
        if (!row.parts?.[index] || row.parts[index].bytes !== bytes.byteLength)
          throw Error("자료 조각 크기가 다릅니다.");
        commands.push({
          type: "part",
          generation,
          row: syncRow.parse(row),
          index,
          bytes: bytes.slice(),
        });
      },
      putOutbox(entry) {
        const e = outboxEntry.parse(entry);
        if (e.owner !== owner) throw Error("서재 계정이 다릅니다.");
        commands.push({
          type: "put",
          store: "outbox",
          key: e.requestId,
          data: e,
        });
      },
      removeOutbox(requestId) {
        commands.push({ type: "delete", store: "outbox", key: requestId });
      },
      putConflict(conflict) {
        commands.push({
          type: "put",
          store: "conflicts",
          key: conflict.requestId,
          data: structuredClone(conflict),
        });
      },
      removeConflict(requestId) {
        commands.push({ type: "delete", store: "conflicts", key: requestId });
      },
      putIndex(generation, key, value) {
        commands.push({
          type: "put",
          store: "indexes",
          generation,
          key,
          data: structuredClone(value),
        });
      },
      removeIndex(generation, key) {
        commands.push({ type: "delete", store: "indexes", generation, key });
      },
    };
    const result = fn(writer);
    if (result && typeof (result as Promise<unknown>).then === "function")
      throw Error(
        "저장 거래 안에서는 통신이나 비동기 작업을 기다릴 수 없습니다.",
      );
    await apply(commands);
  }
  async function checkpoint(
    generation?: string,
  ): Promise<ReplicaGeneration | null> {
    check();
    const id = generation ?? (await backend.get("meta", [owner, "active"]));
    return id ? ((await backend.get("meta", stateKey(id))) ?? null) : null;
  }
  const storage: ReplicaStorage = {
    owner,
    transaction,
    checkpoint,
    async createGeneration(input) {
      const state: ReplicaGeneration = {
        owner,
        generation: crypto.randomUUID(),
        epoch: input.epoch,
        cursor: input.cursor,
        startCursor: input.cursor,
        complete: false,
        startedAt: new Date().toISOString(),
        scan: {},
        rows: 0,
        bytes: 0,
        lastSyncedAt: null,
      };
      await apply([{ type: "init", state }]);
      return state;
    },
    async listGenerations() {
      check();
      return (await backend.scan("meta", [owner, "generation"])).map(
        (e) => e.data as ReplicaGeneration,
      );
    },
    stageRows: (g, rows) => transaction((tx) => tx.stageRows(g, rows)),
    setCheckpoint: (g, patch) =>
      transaction((tx) => tx.setCheckpoint(g, patch)),
    promoteGeneration: (g) => transaction((tx) => tx.promoteGeneration(g)),
    async readRow(entity, key, generation) {
      check();
      const id = generation ?? (await checkpoint())?.generation;
      return id ? backend.get("rows", [owner, id, entity, key]) : undefined;
    },
    async readPage(entity, input = {}) {
      check();
      const id = input.generation ?? (await checkpoint())?.generation;
      if (!id) return { rows: [], hasMore: false };
      const limit = input.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
        throw Error("표시 개수를 확인해 주세요.");
      const prefix = [owner, id, entity],
        entries = await backend.scan(
          "rows",
          prefix,
          input.after ? [...prefix, input.after] : undefined,
          limit + 1,
        ),
        rows = entries.slice(0, limit).map((e) => e.data as SyncRow);
      return {
        rows,
        hasMore: entries.length > limit,
        after: rows.at(-1)?.key ?? input.after,
      };
    },
    putValuePart: (g, row, index, bytes) =>
      transaction((tx) => tx.putValuePart(g, row, index, bytes)),
    async readValuePart(g, row, index) {
      check();
      return backend.get("parts", partKey(g, row, index));
    },
    putOutbox: (entry) => transaction((tx) => tx.putOutbox(entry)),
    async listOutbox() {
      check();
      return (await backend.scan("outbox", [owner]))
        .map((e) => e.data as OutboxEntry)
        .sort(
          (a, b) => a.order - b.order || a.requestId.localeCompare(b.requestId),
        );
    },
    async listConflicts() {
      check();
      return (await backend.scan("conflicts", [owner])).map(
        (e) => e.data as ReplicaConflict,
      );
    },
    async readIndex(key, generation) {
      check();
      const id = generation ?? (await checkpoint())?.generation;
      return id ? backend.get("indexes", [owner, id, key]) : undefined;
    },
    close() {
      closed = true;
      backend.close();
    },
  };
  return storage;
}
