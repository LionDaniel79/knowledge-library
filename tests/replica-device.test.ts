import { describe, expect, it } from "vitest";
import {
  readStorageStatus,
  requestPersistentStorage,
} from "../src/client/replica/device";
import { resourceFixture } from "./helpers/replica-resources";
import { queueReplicaCommand } from "../src/client/replica/outbox";
import {
  createMemoryBackend,
  createMemoryReplica,
} from "../src/client/replica/memory-storage";
import { createReplicaCoordinator } from "../src/client/replica/coordinator";
import { fixtureTransport } from "./helpers/replica-fixture";
import { vi } from "vitest";
describe("device storage reporting", () => {
  it("reuses the same account's completed device copy after reopening instead of scanning the library again", async () => {
    const backend = createMemoryBackend(),
      first = createMemoryReplica("owner", backend),
      f = fixtureTransport("owner", false);
    await createReplicaCoordinator({
      owner: "owner",
      storage: first,
      transport: f.transport,
    }).syncReplica({ reason: "startup" });
    const generation = (await first.checkpoint())!.generation;
    first.close();
    const reopened = createMemoryReplica("owner", backend),
      scan = vi.spyOn(f.transport, "scan");
    await createReplicaCoordinator({
      owner: "owner",
      storage: reopened,
      transport: f.transport,
    }).syncReplica({ reason: "startup" });
    expect(scan).not.toHaveBeenCalled();
    expect((await reopened.checkpoint())!.generation).toBe(generation);
    expect(await reopened.listGenerations()).toHaveLength(1);
  });
  it("prunes unused copies but preserves the active copy, resumable download and unsent edits", async () => {
    const f = await resourceFixture(),
      first = (await f.s.checkpoint())!;
    const active = await f.s.createGeneration({
      epoch: first.epoch,
      cursor: first.cursor,
    });
    await f.s.setCheckpoint(active.generation, { complete: true });
    await f.s.promoteGeneration(active.generation);
    const pending = await f.s.createGeneration({
      epoch: first.epoch,
      cursor: first.cursor,
    });
    await queueReplicaCommand({
      storage: f.s,
      repository: f.repo,
      path: "/api/library",
      body: {
        requestId: crypto.randomUUID(),
        type: "addNote",
        payload: { title: "미전송 생각", content: "보존", kind: "thought" },
      },
    });
    expect((await f.s.deviceCopies()).unused).toBe(1);
    expect(await f.s.pruneUnusedCopies()).toBe(1);
    expect(
      (await f.s.listGenerations()).map((g) => g.generation).sort(),
    ).toEqual([active.generation, pending.generation].sort());
    expect((await f.s.checkpoint())?.generation).toBe(active.generation);
    expect(await f.s.listOutbox()).toHaveLength(1);
    expect(await f.s.pruneUnusedCopies()).toBe(0);
  });
  it("refuses clearing any unsent input; clears only this owner downloads and pauses automatic rebuilding", async () => {
    const f = await resourceFixture();
    await queueReplicaCommand({
      storage: f.s,
      repository: f.repo,
      path: "/api/library",
      body: {
        requestId: crypto.randomUUID(),
        type: "addNote",
        payload: { title: "남길 글", content: "본문", kind: "thought" },
      },
    });
    await expect(f.s.clearDownloaded()).rejects.toThrow("미전송");
    expect((await f.s.checkpoint())?.complete).toBe(true);
    expect(await f.s.listOutbox()).toHaveLength(1);
    const id = (await f.s.listOutbox())[0].requestId;
    await f.s.transaction((tx) => {
      tx.removeOutbox(id);
      tx.putConflict({
        requestId: "archive",
        entityId: "x",
        base: null,
        local: { content: "이전 글" },
        server: null,
        createdAt: new Date().toISOString(),
        resolvedAt: new Date().toISOString(),
      });
    });
    await f.s.clearDownloaded();
    expect(await f.s.checkpoint()).toBeNull();
    expect(await f.s.listGenerations()).toHaveLength(0);
    expect(await f.s.listConflicts(true)).toHaveLength(1);
    expect(await f.s.autoSyncEnabled()).toBe(false);
  });
  it("distinguishes unsupported, denied and accepted persistence without inventing capacity", async () => {
    expect(await readStorageStatus(undefined)).toEqual({
      usage: null,
      quota: null,
      persisted: null,
    });
    expect(await requestPersistentStorage(undefined)).toBeNull();
    const denied = {
      estimate: async () => ({ usage: 100, quota: 1000 }),
      persisted: async () => false,
      persist: async () => false,
    };
    expect(await readStorageStatus(denied)).toEqual({
      usage: 100,
      quota: 1000,
      persisted: false,
    });
    expect(await requestPersistentStorage(denied)).toBe(false);
    expect(
      await requestPersistentStorage({ ...denied, persist: async () => true }),
    ).toBe(true);
    expect(
      await readStorageStatus({
        estimate: async () => {
          throw Error("blocked");
        },
      }),
    ).toEqual({ usage: null, quota: null, persisted: null });
  });
});
