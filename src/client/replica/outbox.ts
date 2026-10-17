import type { ReplicaStorage } from "./storage";
import type { ReplicaRepository } from "./repository";
import {
  commandFamily,
  prepareOptimistic,
  type QueuedChange,
} from "./optimistic";
import { contentHash } from "../../lib/thought-map/records";
import { ReplicaQueryError } from "./queries";
import type { Book, ReadingCycle } from "../../lib/domain";
export type ReadingSnapshot = { cycle: ReadingCycle; book: Book };
export async function queueReplicaCommand(input: {
  storage: ReplicaStorage;
  repository: ReplicaRepository;
  path: string;
  body: any;
  readingSnapshot?: ReadingSnapshot;
}) {
  const { storage, repository, path } = input,
    requestId = input.body.requestId ?? crypto.randomUUID(),
    original = { ...input.body, requestId },
    family = commandFamily(path);
  if (!family)
    throw new ReplicaQueryError(400, "온라인으로 처리할 기능입니다.");
  const cp = await storage.checkpoint();
  const seed = input.readingSnapshot;
  const partialProgress =
    !cp?.complete &&
    !!seed &&
    path === "/api/library" &&
    original.type === "updateProgress" &&
    seed?.cycle.id === original.payload?.id &&
    seed.cycle.bookId === seed.book.id;
  if (!cp?.complete && !partialProgress)
    throw new ReplicaQueryError(503, "기기 자료를 준비하고 있습니다.");
  const entries = await storage.listOutbox(),
    inputHash = contentHash(JSON.stringify({ path, body: original })),
    old = entries.find((e) => e.requestId === requestId);
  if (old) {
    if ((old.command as QueuedChange).inputHash !== inputHash)
      throw new ReplicaQueryError(409, "같은 요청 번호의 내용이 다릅니다.");
    return (old.command as QueuedChange).result;
  }
  const at = new Date().toISOString(),
    prepared = await prepareOptimistic(
      partialProgress
        ? {
            ...repository,
            raw: async (entity, id) => {
              for (const entry of [...entries].reverse()) {
                const effect = (entry.command as QueuedChange).effects?.find(
                  (e) => e.entity === entity && e.after?.id === id,
                );
                if (effect) return effect.after ?? undefined;
              }
              const existing = await repository.raw(entity, id);
              if (existing) return existing;
              if (entity === "library_cycles" && id === seed!.cycle.id) {
                const c = seed!.cycle;
                return {
                  id: c.id,
                  book_id: c.bookId,
                  status: c.status,
                  current_page: c.currentPage,
                  version: c.version,
                  started_on: c.startedOn,
                  completed_on: c.completedOn,
                  created_at: c.createdAt,
                };
              }
              if (entity === "library_books" && id === seed!.book.id)
                return { id, total_pages: seed!.book.totalPages };
              return undefined;
            },
          }
        : repository,
      path,
      original,
      at,
    ),
    command: QueuedChange = {
      path,
      body: prepared.body,
      at,
      base: prepared.base,
      effects: prepared.effects,
      result: prepared.result,
      inputHash,
    };
  const keys = new Set(prepared.effects.map((e) => e.entity + ":" + e.key)),
    text = JSON.stringify(prepared.body),
    dependsOn = entries
      .filter(
        (e) =>
          e.entityId === prepared.entityId ||
          text.includes(e.entityId) ||
          (e.command as QueuedChange).effects?.some((effect) =>
            keys.has(effect.entity + ":" + effect.key),
          ),
      )
      .map((e) => e.requestId);
  const entry = {
    owner: storage.owner,
    requestId,
    entityId: prepared.entityId,
    baseVersion:
      typeof prepared.base?.version === "number" ? prepared.base.version : null,
    baseRevision: await (async () => {
      const primary = prepared.effects.find(
        (e) =>
          e.entity !== "library_revisions" && e.after?.id === prepared.entityId,
      );
      return primary
        ? ((await storage.readRow(primary.entity, primary.key, cp?.generation))
            ?.revision ?? null)
        : null;
    })(),
    family,
    command,
    order: entries.reduce(
      (max, e) => Math.max(max, e.order + 1),
      Date.now() * 1000,
    ),
    dependsOn: dependsOn.slice(-200),
    state: "pending" as const,
  };
  await storage.transaction((tx) => {
    if (cp?.complete) tx.expectCheckpoint(cp.generation, cp);
    tx.putOutbox(
      entry,
      prepared.effects.map((e) => e.entity),
    );
  });
  repository.invalidate();
  return prepared.result;
}
