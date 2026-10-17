import { expect, it } from "vitest";
import {
  createMemoryReplica,
  createMemoryBackend,
} from "../src/client/replica/memory-storage";
import type { SyncRow } from "../src/lib/replica/contracts";
const epoch = "11111111-1111-4111-8111-111111111111";
const row = (revision = "1", inline = "{}"): SyncRow => ({
  entity: "library_books",
  key: '["book"]',
  revision,
  deleted: false,
  sha256: "a".repeat(64),
  bytes: inline.length,
  inline,
});
it("promotes complete generations atomically, rolls back failures and preserves the outbox through a rebuild", async () => {
  const s = createMemoryReplica("owner");
  const old = await s.createGeneration({ epoch, cursor: "start" });
  await s.stageRows(old.generation, [row()]);
  await s.setCheckpoint(old.generation, { complete: true });
  await s.promoteGeneration(old.generation);
  const pending = await s.createGeneration({ epoch, cursor: "next" });
  await s.putOutbox({
    owner: "owner",
    requestId: crypto.randomUUID(),
    entityId: "book",
    baseVersion: 1,
    baseRevision: "1",
    family: "library",
    command: { type: "editBook" },
    order: 1,
    dependsOn: [],
    state: "pending",
  });
  await expect(
    s.transaction((tx) => {
      tx.stageRows(old.generation, [row("2")]);
      tx.setCheckpoint("missing", { complete: true });
    }),
  ).rejects.toThrow();
  expect((await s.readRow("library_books", '["book"]'))?.revision).toBe("1");
  await expect(s.promoteGeneration(pending.generation)).rejects.toThrow();
  expect((await s.checkpoint())?.generation).toBe(old.generation);
  await s.stageRows(pending.generation, [row("3")]);
  await s.transaction((tx) => {
    tx.setCheckpoint(pending.generation, {
      complete: true,
      cursor: "committed",
    });
    tx.promoteGeneration(pending.generation);
  });
  expect((await s.checkpoint())?.cursor).toBe("committed");
  expect((await s.listOutbox()).length).toBe(1);
  expect((await s.readRow("library_books", '["book"]'))?.revision).toBe("3");
});
it("isolates owners, ignores stale row responses and stores value parts independently of view data", async () => {
  const backend = createMemoryBackend(),
    a = createMemoryReplica("a", backend),
    b = createMemoryReplica("b", backend);
  const g = await a.createGeneration({ epoch, cursor: "start" });
  await a.stageRows(g.generation, [row("9"), row("2")]);
  expect(
    (await a.readRow("library_books", '["book"]', g.generation))?.revision,
  ).toBe("9");
  expect(
    await b.readRow("library_books", '["book"]', g.generation),
  ).toBeUndefined();
  const large = {
    ...row("10"),
    inline: undefined,
    bytes: 3,
    parts: [{ index: 0, bytes: 3, sha256: "b".repeat(64) }],
  };
  await a.stageRows(g.generation, [large]);
  await a.putValuePart(g.generation, large, 0, new Uint8Array([1, 2, 3]));
  expect(await a.readValuePart(g.generation, large, 0)).toEqual(
    new Uint8Array([1, 2, 3]),
  );
  expect(await b.readValuePart(g.generation, large, 0)).toBeUndefined();
  await expect(a.transaction((async () => {}) as never)).rejects.toThrow();
});
it("keeps the active search index separate from a generation still being rebuilt", async () => {
  const s = createMemoryReplica("index-owner");
  const active = await s.createGeneration({ epoch, cursor: "old" });
  await s.transaction((tx) => {
    tx.putIndex(active.generation, "titles", ["이전 책"]);
    tx.setCheckpoint(active.generation, { complete: true });
    tx.promoteGeneration(active.generation);
  });
  const pending = await s.createGeneration({ epoch, cursor: "new" });
  await s.transaction((tx) =>
    tx.putIndex(pending.generation, "titles", ["새 책"]),
  );
  expect(await s.readIndex("titles")).toEqual(["이전 책"]);
  expect(await s.readIndex("titles", pending.generation)).toEqual(["새 책"]);
});
