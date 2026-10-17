import type { OutboxEntry } from "../../lib/replica/contracts";
import type { ReplicaStorage } from "./storage";
import type { QueuedChange } from "./optimistic";
const referenceFields = new Set([
  "id",
  "entityId",
  "bookId",
  "noteId",
  "researchId",
  "itemId",
  "sourceId",
  "targetId",
  "topicId",
  "parentId",
  "sourceTopicId",
  "targetTopicId",
  "book_id",
  "note_id",
  "research_id",
  "source_id",
  "target_id",
  "topic_id",
  "parent_id",
]);
function remapReferences(value: any, from: string, to: string): any {
  if (Array.isArray(value))
    return value.map((v) => remapReferences(v, from, to));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, v]) => [
      key,
      referenceFields.has(key) && v === from
        ? to
        : remapReferences(v, from, to),
    ]),
  );
}
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
            const c = child.command as QueuedChange;
            // Rewrite only structured ID fields; never user prose, request IDs or the original retry fingerprint.
            const command = {
              ...c,
              body: remapReferences(c.body, entry.entityId, canonical),
              base: remapReferences(c.base, entry.entityId, canonical),
              result: remapReferences(c.result, entry.entityId, canonical),
              effects: c.effects.map((effect) => ({
                ...effect,
                key: JSON.stringify(
                  (JSON.parse(effect.key) as unknown[]).map((k) =>
                    k === entry.entityId ? canonical : k,
                  ),
                ),
                after: remapReferences(effect.after, entry.entityId, canonical),
              })),
            };
            tx.putOutbox({
              ...child,
              entityId:
                child.entityId === entry.entityId ? canonical : child.entityId,
              command,
            });
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
}): Promise<PushReport> {
  const { storage, send, pull } = input,
    entries = (await storage.listOutbox()).sort(
      (a, b) => a.order - b.order || a.requestId.localeCompare(b.requestId),
    ),
    confirmed: string[] = [];
  const attempted = new Set<string>(),
    batchIds = new Set(entries.map((e) => e.requestId));
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
