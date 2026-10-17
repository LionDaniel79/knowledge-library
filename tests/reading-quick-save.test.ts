import { it, expect } from "vitest";
import { createMemoryReplica } from "../src/client/replica/memory-storage";
import { createReplicaRepository } from "../src/client/replica/repository";
import { queueReplicaCommand } from "../src/client/replica/outbox";
import type { Book, ReadingCycle } from "../src/lib/domain";
import { createMemoryBackend } from "../src/client/replica/memory-storage";
import { resourceFixture } from "./helpers/replica-resources";
import { sha256Bytes } from "../src/lib/replica/codec";
import { syncKey } from "../src/lib/replica/entities";
const book = {
  id: "11111111-1111-4111-8111-111111111111",
  totalPages: 500,
} as Book;
const cycle: ReadingCycle = {
  id: "22222222-2222-4222-8222-222222222222",
  bookId: book.id,
  status: "reading",
  startedOn: null,
  completedOn: null,
  currentPage: 20,
  version: 1,
  createdAt: "2026-10-17T01:00:00Z",
};
it("durably queues successive progress before the first library download finishes without marking it complete", async () => {
  const storage = createMemoryReplica("owner"),
    repository = createReplicaRepository(storage);
  try {
    const first = {
      requestId: crypto.randomUUID(),
      type: "updateProgress",
      payload: { id: cycle.id, expectedVersion: 1, currentPage: 35 },
    };
    const result = await queueReplicaCommand({
      storage,
      repository,
      path: "/api/library",
      body: first,
      readingSnapshot: { cycle, book },
    });
    expect(result).toMatchObject({ version: 2, queued: true });
    await queueReplicaCommand({
      storage,
      repository,
      path: "/api/library",
      body: {
        requestId: crypto.randomUUID(),
        type: "updateProgress",
        payload: { id: cycle.id, expectedVersion: 2, currentPage: 40 },
      },
      readingSnapshot: {
        cycle: { ...cycle, version: 2, currentPage: 35 },
        book,
      },
    });
    const entries = await storage.listOutbox();
    expect(entries).toHaveLength(2);
    expect(entries[1].dependsOn).toContain(first.requestId);
    expect(
      (entries[1].command as any).effects.find(
        (e: any) => e.entity === "library_cycles",
      ).after.current_page,
    ).toBe(40);
    expect((await storage.checkpoint())?.complete).not.toBe(true);
    await expect(
      queueReplicaCommand({
        storage,
        repository,
        path: "/api/library",
        body: {
          ...first,
          requestId: crypto.randomUUID(),
          payload: { ...first.payload, currentPage: 600 },
        },
        readingSnapshot: { cycle, book },
      }),
    ).rejects.toThrow();
  } finally {
    repository.close();
    storage.close();
  }
});
it("invalidates an overview built by first-copy promotion while a progress write is being prepared", async () => {
  const backend = createMemoryBackend(),
    storage = createMemoryReplica("resources", backend),
    f = await resourceFixture(storage);
  const cp = (await storage.checkpoint())!;
  const row = {
    id: cycle.id,
    book_id: f.book,
    status: "reading",
    current_page: 20,
    version: 1,
    started_on: null,
    completed_on: null,
    created_at: cycle.createdAt,
  };
  const inline = JSON.stringify(row),
    bytes = new TextEncoder().encode(inline);
  await storage.stageRows(cp.generation, [
    {
      entity: "library_cycles",
      key: syncKey("library_cycles", row),
      revision: "1",
      deleted: false,
      inline,
      bytes: bytes.length,
      sha256: await sha256Bytes(bytes),
    },
  ]);
  await backend.transaction(async (io) => {
    await io.delete("meta", [storage.owner, "active"]);
  });
  const racing = {
    ...storage,
    checkpoint: async () => {
      const before = await storage.checkpoint();
      await storage.promoteGeneration(cp.generation);
      expect((await f.repo.overview()).cycles[0].currentPage).toBe(20);
      return before;
    },
  };
  try {
    await queueReplicaCommand({
      storage: racing,
      repository: f.repo,
      path: "/api/library",
      body: {
        requestId: crypto.randomUUID(),
        type: "updateProgress",
        payload: { id: cycle.id, expectedVersion: 1, currentPage: 35 },
      },
      readingSnapshot: {
        cycle: { ...cycle, bookId: f.book },
        book: { ...book, id: f.book },
      },
    });
    expect((await f.repo.overview()).cycles[0].currentPage).toBe(35);
    expect(
      (await storage.checkpoint())!.localEntityRevisions?.library_cycles,
    ).toBe(1);
  } finally {
    f.repo.close();
    storage.close();
  }
});
