import { z } from "zod";
import type { SyncStatus } from "../../lib/replica/contracts";
import type { ReplicaStorage, ReplicaGeneration } from "./storage";
import { createReplicaRepository } from "./repository";
import { createReplicaCoordinator } from "./coordinator";
import { createSyncTransport, SyncHttpError } from "./transport";
import { queueReplicaCommand } from "./outbox";
export async function verifiedSyncOwner(signal?: AbortSignal): Promise<string> {
  const response = await fetch("/api/sync/session", {
    cache: "no-store",
    credentials: "same-origin",
    redirect: "error",
    signal,
  });
  const body = await response.json();
  if (!response.ok)
    throw new SyncHttpError(
      response.status,
      body.error ?? "Google 계정으로 다시 로그인해 주세요.",
    );
  return z
    .object({ ownerId: z.string().min(1).max(128) })
    .strict()
    .parse(body).ownerId;
}
export interface RuntimeSnapshot {
  ready: boolean;
  revision: number;
  status: SyncStatus;
  authRequired: boolean;
}
export function createLibraryRuntime(
  owner: string,
  storage: ReplicaStorage,
  checkpoint: ReplicaGeneration | null,
) {
  const repository = createReplicaRepository(storage),
    coordinator = createReplicaCoordinator({
      owner,
      storage,
      transport: createSyncTransport(),
    }),
    abort = new AbortController(),
    listeners = new Set<() => void>();
  let verified = false,
    closed = false,
    active: Promise<SyncStatus> | null = null;
  let capabilitiesAt = 0;
  let dataToken = checkpoint
    ? checkpoint.generation + "\0" + checkpoint.cursor
    : "";
  let snapshot: RuntimeSnapshot = Object.freeze({
    ready: !!checkpoint?.complete,
    revision: 0,
    status: {
      ...coordinator.getStatus(),
      rows: checkpoint?.rows ?? 0,
      bytes: checkpoint?.bytes ?? 0,
      lastSyncedAt: checkpoint?.lastSyncedAt ?? null,
    },
    authRequired: false,
  });
  function emit(patch: Partial<RuntimeSnapshot>) {
    if (closed) return;
    snapshot = Object.freeze({ ...snapshot, ...patch });
    for (const listener of listeners) listener();
  }
  const unsubscribe = coordinator.subscribe(() => {
    const status = coordinator.getStatus();
    emit({
      status:
        active && status.phase === "complete"
          ? { ...status, phase: "checking" }
          : status,
    });
  });
  function verifyOwner(actual: string) {
    if (actual !== owner)
      throw new SyncHttpError(403, "로그인한 서재 계정이 변경되었습니다.");
    verified = true;
    emit({ authRequired: false });
  }
  function sync(options: {
    reason: string;
    rebuild?: boolean;
  }): Promise<SyncStatus> {
    if (active) {
      if (["server-save", "local-save"].includes(options.reason))
        return active.then(() => sync(options));
      return active;
    }
    emit({ status: { ...snapshot.status, phase: "preparing", error: "" } });
    active = Promise.resolve()
      .then(async () => {
        try {
          verifyOwner(await verifiedSyncOwner(abort.signal));
          const status = await coordinator.syncReplica({
            ...options,
            signal: abort.signal,
          });
          const cp = await storage.checkpoint(),
            token = cp
              ? cp.generation + "\0" + cp.cursor + ":" + (cp.localRevision ?? 0)
              : "";
          emit({
            ready: !!cp?.complete,
            status,
            revision: snapshot.revision + (token !== dataToken ? 1 : 0),
            authRequired: false,
          });
          dataToken = token;
          if (cp?.complete && Date.now() - capabilitiesAt > 300000) {
            capabilitiesAt = Date.now();
            void fetch("/api/sync/capabilities", {
              cache: "no-store",
              credentials: "same-origin",
              redirect: "error",
              signal: abort.signal,
            })
              .then(async (response) => {
                if (!response.ok) return;
                const v = z
                  .object({
                    ownerId: z.string(),
                    execution: z.enum(["server", "pc"]),
                    comparisonEnabled: z.boolean(),
                    workers: z
                      .array(
                        z.object({
                          key_ready: z.boolean(),
                          price_version: z.string(),
                          last_seen: z.string(),
                          name: z.string(),
                        }),
                      )
                      .max(100),
                  })
                  .strict()
                  .parse(await response.json());
                if (v.ownerId !== owner || closed) return;
                await storage.transaction((tx) =>
                  tx.putIndex(cp.generation, "online-capabilities", {
                    ...v,
                    checkedAt: new Date().toISOString(),
                  }),
                );
                emit({ revision: snapshot.revision + 1 });
              })
              .catch(() => {});
          }
          return status;
        } catch (error) {
          const authRequired =
            error instanceof SyncHttpError && error.status === 401;
          if (authRequired) verified = false;
          emit({
            authRequired,
            status: {
              ...snapshot.status,
              phase:
                typeof navigator !== "undefined" && !navigator.onLine
                  ? "offline"
                  : "error",
              error:
                error instanceof Error
                  ? error.message
                  : "동기화를 다시 시도해 주세요.",
            },
          });
          throw error;
        }
      })
      .finally(() => {
        active = null;
      });
    return active;
  }
  return {
    owner,
    storage,
    repository,
    coordinator,
    sync,
    async queue(path: string, body: unknown) {
      const result = await queueReplicaCommand({
        storage,
        repository,
        path,
        body,
      });
      const pending = await storage.listOutbox();
      emit({
        revision: snapshot.revision + 1,
        status: {
          ...snapshot.status,
          pending: pending.filter((e) =>
            ["pending", "sending"].includes(e.state),
          ).length,
        },
      });
      void sync({ reason: "local-save" }).catch(() => {});
      return result;
    },
    verifyOwner,
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    requireAuthentication() {
      verified = false;
      emit({ authRequired: true });
    },
    close() {
      closed = true;
      abort.abort();
      unsubscribe();
      repository.close();
      storage.close();
      listeners.clear();
    },
  };
}
export type LibraryRuntime = ReturnType<typeof createLibraryRuntime>;
