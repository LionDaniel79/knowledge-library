import type { OutboxEntry } from "../../lib/replica/contracts";
import type { ReplicaStorage } from "./storage";
import type { QueuedChange } from "./optimistic";
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
}): Promise<PushReport> {
  const { storage, send, pull } = input,
    entries = (await storage.listOutbox()).sort(
      (a, b) => a.order - b.order || a.requestId.localeCompare(b.requestId),
    ),
    confirmed: string[] = [];
  const blocked = new Set(
    entries
      .filter((e) => ["conflict", "failed"].includes(e.state))
      .map((e) => e.requestId),
  );
  for (const entry of entries) {
    if (
      blocked.has(entry.requestId) ||
      entry.dependsOn.some((id) => blocked.has(id))
    ) {
      blocked.add(entry.requestId);
      continue;
    }
    const change = entry.command as QueuedChange;
    try {
      if (!change.ack) {
        await storage.putOutbox({ ...entry, state: "sending" });
        await storage.assertWriteLease();
        const ack = await send(entry);
        await storage.putOutbox({
          ...entry,
          state: "sending",
          command: { ...change, ack },
        });
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
        blocked.add(entry.requestId);
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
        blocked.add(entry.requestId);
        continue;
      }
      // The request may already be committed. Keep its id and input for replay.
      await storage.putOutbox({ ...entry, state: "pending" });
      throw error;
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
