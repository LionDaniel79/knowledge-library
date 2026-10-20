import { parseSyncCursor, type SyncStatus } from "../../lib/replica/contracts";
import type { ReplicaStorage } from "./storage";
import type { SyncTransport } from "./transport";
import { SyncHttpError } from "./transport";
import { bootstrapReplica } from "./bootstrap";
import { pullReplica } from "./pull";
import { pushReplica } from "./push";
import { withReplicaLeader } from "./leadership";
export function createReplicaCoordinator(input: {
  owner: string;
  storage: ReplicaStorage;
  transport: SyncTransport;
}) {
  const { owner, storage, transport } = input;
  let status: SyncStatus = Object.freeze({
      phase: "idle",
      rows: 0,
      bytes: 0,
      remaining: 0,
      pending: 0,
      failed: 0,
      conflicts: 0,
      lastSyncedAt: null,
      error: "",
    }),
    running: Promise<SyncStatus> | null = null;
  const listeners = new Set<() => void>();
  function update(patch: Partial<SyncStatus>) {
    status = Object.freeze({ ...status, ...patch });
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        /* UI errors never roll back a saved cursor. */
      }
    }
  }
  async function counts() {
    const entries = await storage.listOutbox();
    return {
      pending: entries.filter(
        (e) => e.state === "pending" || e.state === "sending",
      ).length,
      failed: entries.filter((e) => e.state === "failed").length,
      conflicts: Math.max(
        entries.filter((e) => e.state === "conflict").length,
        (await storage.listConflicts()).length,
      ),
    };
  }
  async function run(
    options: {
      reason: string;
      signal?: AbortSignal;
      rebuild?: boolean;
    },
    storage: ReplicaStorage = input.storage,
  ) {
    update({ phase: "preparing", error: "" });
    try {
      update(await counts());
      const saved = await storage.checkpoint();
      const partial = !saved ? await storage.deviceCopies() : null;
      update({
        rows: saved?.rows ?? partial?.resumableRows ?? 0,
        bytes: saved?.bytes ?? partial?.resumableBytes ?? 0,
      });
      const meta = await transport.meta(false, options.signal),
        current = await storage.checkpoint();
      let state = current;
      const position =
        current && current.epoch === meta.epoch
          ? parseSyncCursor(current.cursor, owner, meta.epoch)
          : null;
      const rebuild =
        options.rebuild ||
        !current?.complete ||
        !position ||
        (current.changeOrderVersion !== 2 && BigInt(meta.floor) > 0n) ||
        BigInt(position.after) < BigInt(meta.floor);
      if (rebuild) {
        state = await bootstrapReplica({
          owner,
          storage,
          transport,
          signal: options.signal,
          fresh: options.rebuild,
          onProgress: (p) =>
            update({
              phase: p.phase,
              rows: p.rows,
              bytes: p.bytes,
              remaining: Math.max(0, p.totalRows - p.rows),
            }),
        });
      } else if (
        position!.after !== meta.head ||
        current.changeOrderVersion !== 2
      ) {
        update({ phase: "pulling", rows: current.rows, bytes: current.bytes });
        try {
          state = await pullReplica({
            owner,
            storage,
            transport,
            meta,
            replayChanges: current.changeOrderVersion === undefined,
            signal: options.signal,
            onProgress: (rows, bytes) => update({ rows, bytes }),
          });
        } catch (error) {
          if (
            !(error instanceof SyncHttpError) ||
            ![409, 410].includes(error.status)
          )
            throw error;
          state = await bootstrapReplica({
            owner,
            storage,
            transport,
            signal: options.signal,
            onProgress: (p) =>
              update({
                phase: p.phase,
                rows: p.rows,
                bytes: p.bytes,
                remaining: Math.max(0, p.totalRows - p.rows),
              }),
          });
        }
      } else {
        const lastSyncedAt = new Date().toISOString();
        await storage.setCheckpoint(current.generation, { lastSyncedAt });
        state = { ...current, lastSyncedAt };
      }
      if (!state) throw Error("기기 자료가 준비되지 않았습니다.");
      if (transport.push && (await storage.listOutbox()).length) {
        update({ phase: "pushing" });
        await pushReplica({
          storage,
          send: (entry) => transport.push!(entry, options.signal),
          pull: async () => {
            const meta = await transport.meta(false, options.signal),
              cp = (await storage.checkpoint())!;
            if (
              cp.epoch !== meta.epoch ||
              BigInt(parseSyncCursor(cp.cursor, owner, meta.epoch).after) <
                BigInt(meta.floor)
            )
              state = await bootstrapReplica({
                owner,
                storage,
                transport,
                signal: options.signal,
                fresh: true,
              });
            else
              state = await pullReplica({
                owner,
                storage,
                transport,
                meta,
                signal: options.signal,
              });
          },
        });
        state = await storage.checkpoint();
        if (!state) throw Error("기기 자료를 다시 확인해 주세요.");
      }
      update({
        phase: "complete",
        rows: state.rows,
        bytes: state.bytes,
        remaining: 0,
        lastSyncedAt: state.lastSyncedAt,
        error: "",
        ...(await counts()),
      });
      return status;
    } catch (error) {
      update({
        phase:
          typeof navigator !== "undefined" && navigator.onLine === false
            ? "offline"
            : "error",
        error:
          error instanceof Error
            ? error.message
            : "동기화를 다시 시도해 주세요.",
        ...(await counts().catch(() => ({
          pending: status.pending,
          failed: status.failed,
          conflicts: status.conflicts,
        }))),
      });
      throw error;
    }
  }
  return {
    getStatus: () => status,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    syncReplica(options: {
      reason: string;
      signal?: AbortSignal;
      rebuild?: boolean;
    }): Promise<SyncStatus> {
      if (running) return running;
      running = Promise.resolve()
        .then(() =>
          withReplicaLeader(
            owner,
            (leader) =>
              run({ ...options, signal: leader.signal }, leader.storage),
            { storage, signal: options.signal },
          ),
        )
        .catch((error) => {
          update({
            phase:
              typeof navigator !== "undefined" && navigator.onLine === false
                ? "offline"
                : "error",
            error:
              error instanceof Error
                ? error.message
                : "동기화를 다시 시도해 주세요.",
          });
          throw error;
        })
        .finally(() => {
          running = null;
        });
      return running;
    },
  };
}
export type ReplicaCoordinator = ReturnType<typeof createReplicaCoordinator>;
