import { describe, expect, it } from "vitest";
import {
  readStorageStatus,
  requestPersistentStorage,
} from "../src/client/replica/device";
import { resourceFixture } from "./helpers/replica-resources";
import { queueReplicaCommand } from "../src/client/replica/outbox";
describe("device storage reporting", () => {
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
