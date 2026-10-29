import type { OutboxEntry } from "../../lib/replica/contracts";
import type { ReplicaStorage } from "./storage";
import type { QueuedChange } from "./optimistic";
import { remapQueuedEntry } from "./reference-remap";
async function saveAcknowledgement(
  storage: ReplicaStorage,
  entry: OutboxEntry,
  ack: any,
) {
  const original = entry.command as QueuedChange;
  const canonical =
    typeof ack?.id === "string" &&
    ack.id !== entry.entityId &&
    original.body.entityId === entry.entityId
      ? ack.id
      : null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const cp = await storage.checkpoint(),
      all = await storage.listOutbox();
    try {
      await storage.transaction((tx) => {
        if (cp) tx.expectCheckpoint(cp.generation, cp);
        tx.putOutbox({
          ...entry,
          state: "sending",
          command: { ...original, ack },
        });
        if (canonical)
          for (const child of all) {
            if (
              child.requestId === entry.requestId ||
              (child.command as QueuedChange).ack
            )
              continue;
            tx.putOutbox(remapQueuedEntry(child, entry.entityId, canonical));
          }
        if (cp)
          tx.setCheckpoint(cp.generation, {
            localRevision: (cp.localRevision ?? 0) + 1,
          });
      });
      return;
    } catch (error) {
      if ((error as { status?: number }).status === 409) {
        if (attempt < 4) continue;
        throw Error("다른 창의 입력을 저장 중입니다. 다시 동기화해 주세요.");
      }
      throw error;
    }
  }
}
export interface PushReport {
  confirmed: number;
  remaining: number;
  conflicts: number;
  failed: number;
}
export async function pushReplica(input: {
  storage: ReplicaStorage;
  send: (entry: OutboxEntry) => Promise<unknown>;
  pull: () => Promise<void>;
  onProgress?: (progress: { processed: number; total: number }) => void;
}): Promise<PushReport> {
  const { storage, send, pull } = input,
    entries = (await storage.listOutbox()).sort(
      (a, b) => a.order - b.order || a.requestId.localeCompare(b.requestId),
    ),
    confirmed: string[] = [];
  const attempted = new Set<string>(),
    batchIds = new Set(entries.map((e) => e.requestId)),
    total = entries.filter(
      (e) => !["conflict", "failed"].includes(e.state),
    ).length;
  const progress = () =>
    input.onProgress?.({ processed: attempted.size, total });
  progress();
  while (true) {
    const latest = (await storage.listOutbox()).sort(
      (a, b) => a.order - b.order || a.requestId.localeCompare(b.requestId),
    );
    const byId = new Map(latest.map((e) => [e.requestId, e]));
    const entry = latest.find(
      (e) =>
        batchIds.has(e.requestId) &&
        !attempted.has(e.requestId) &&
        !["conflict", "failed"].includes(e.state) &&
        e.dependsOn.every(
          (id) =>
            !byId.has(id) || !!(byId.get(id)!.command as QueuedChange).ack,
        ),
    );
    if (!entry) break;
    attempted.add(entry.requestId);
    const change = entry.command as QueuedChange;
    try {
      if (!change.ack) {
        await storage.putOutbox({ ...entry, state: "sending" });
        await storage.assertWriteLease();
        const ack = await send(entry);
        await saveAcknowledgement(storage, entry, ack);
      }
      confirmed.push(entry.requestId);
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 409 || status === 404) {
        await storage.transaction((tx) => {
          tx.putOutbox({
            ...entry,
            state: "conflict",
            command: { ...change, error: (error as Error).message },
          });
          tx.putConflict({
            requestId: entry.requestId,
            entityId: entry.entityId,
            local: change,
            base: change.base,
            server: null,
            createdAt: new Date().toISOString(),
          });
        });
        continue;
      }
      if (
        status &&
        status >= 400 &&
        status < 500 &&
        ![401, 403, 408, 429].includes(status)
      ) {
        await storage.putOutbox({
          ...entry,
          state: "failed",
          command: { ...change, error: (error as Error).message },
        });
        continue;
      }
      // The request may already be committed. Keep its id and input for replay.
      await storage.putOutbox({ ...entry, state: "pending" });
      throw error;
    } finally {
      progress();
    }
  }
  if (confirmed.length) {
    await pull();
    for (let attempt = 0; attempt < 5; attempt++) {
      const cp = await storage.checkpoint(),
        localEntityRevisions = { ...cp?.localEntityRevisions };
      for (const e of entries.filter((e) => confirmed.includes(e.requestId)))
        for (const effect of (e.command as QueuedChange).effects ?? [])
          localEntityRevisions[effect.entity] =
            (localEntityRevisions[effect.entity] ?? 0) + 1;
      try {
        await storage.transaction((tx) => {
          if (cp) tx.expectCheckpoint(cp.generation, cp);
          for (const id of confirmed) tx.removeOutbox(id);
          if (cp)
            tx.setCheckpoint(cp.generation, {
              localRevision: (cp.localRevision ?? 0) + 1,
              localEntityRevisions,
            });
        });
      } catch (error) {
        if ((error as { status?: number }).status === 409 && attempt < 4)
          continue;
        throw error;
      }
      break;
    }
  }
  const remaining = await storage.listOutbox();
  return {
    confirmed: confirmed.length,
    remaining: remaining.length,
    conflicts: remaining.filter((e) => e.state === "conflict").length,
    failed: remaining.filter((e) => e.state === "failed").length,
  };
}
