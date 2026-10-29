import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { createKnowledgeStore } from "../src/server/knowledge-store";
import { createLibraryStore } from "../src/server/library-store";
import { readWhiteboard } from "../src/server/whiteboard-store";
import { resourceFixture } from "./helpers/replica-resources";
import { queueReplicaCommand } from "../src/client/replica/outbox";
import { createMemoryReplica } from "../src/client/replica/memory-storage";
import { createReplicaRepository } from "../src/client/replica/repository";
import { createReplicaCoordinator } from "../src/client/replica/coordinator";
import { sqlSyncTransport } from "./helpers/sync-transport";
import {
  createLibraryBackup,
  inspectLibraryBackup,
  restoreLibraryBackup,
} from "../src/server/library-backup";
import { vi } from "vitest";
import {
  loadReplicaConflict,
  applyReplicaResolution,
} from "../src/client/replica/conflicts";
let f: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  f = await testDatabase();
});
afterAll(async () => {
  await f?.pg.close();
});
const cmd = (type: string, payload: unknown) => ({
  requestId: randomUUID(),
  type,
  payload,
});
it("persists independent overlapping bundles, enforces ownership/version, and unlinks bundles without unlinking notes", async () => {
  const owner = randomUUID(),
    store = createKnowledgeStore(f.db),
    library = createLibraryStore(f.db);
  const a = (
    await library.mutate(owner, cmd("addNote", { content: "첫 생각" }))
  ).id!;
  const b = (
    await library.mutate(owner, cmd("addNote", { content: "둘째 생각" }))
  ).id!;
  await store.mutate(
    owner,
    cmd("connectWhiteboardNotes", { sourceId: a, targetId: b }),
  );
  const create = cmd("saveMemoBundle", {
    title: "조직의 문제",
    description: "내가 정리한 생각",
    noteIds: [a, b],
    expectedVersion: 0,
  });
  const first = await store.mutate(owner, create);
  expect(await store.mutate(owner, create)).toEqual(first);
  const second = await store.mutate(
    owner,
    cmd("saveMemoBundle", {
      title: "교회 회복",
      description: "",
      noteIds: [a],
      expectedVersion: 0,
    }),
  );
  const edge = await store.mutate(
    owner,
    cmd("saveBundleLink", {
      sourceId: first.id,
      targetId: second.id,
      relation: "applies",
      reason: "교회에도 적용",
      status: "accepted",
      expectedVersion: 0,
    }),
  );
  let snapshot = await readWhiteboard(f.db, owner);
  expect(snapshot.bundles?.map((g) => g.note_ids)).toContainEqual([a]);
  expect(snapshot.bundles).toHaveLength(2);
  expect(snapshot.bundleLinks).toHaveLength(1);
  await expect(
    store.mutate(
      randomUUID(),
      cmd("saveMemoBundle", {
        id: first.id,
        title: "침입",
        description: "",
        noteIds: [],
        expectedVersion: 1,
      }),
    ),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    store.mutate(
      owner,
      cmd("saveMemoBundle", {
        id: first.id,
        title: "덮어쓰기",
        description: "",
        noteIds: [a],
        expectedVersion: 0,
      }),
    ),
  ).rejects.toMatchObject({ status: 409 });
  await store.mutate(
    owner,
    cmd("saveBundleLink", {
      id: edge.id,
      sourceId: second.id,
      targetId: first.id,
      relation: "applies",
      reason: "교회에도 적용",
      status: "rejected",
      expectedVersion: 1,
    }),
  );
  snapshot = await readWhiteboard(f.db, owner);
  expect(
    snapshot.bundleLinks?.filter((l) => l.status === "accepted"),
  ).toHaveLength(0);
  expect(
    snapshot.connections.filter((c) => c.status === "accepted"),
  ).toHaveLength(1);
  await store.mutate(
    owner,
    cmd("archiveMemoBundle", { id: first.id, expectedVersion: 1 }),
  );
  expect((await readWhiteboard(f.db, owner)).bundles).toHaveLength(1);
  expect((await library.snapshot(owner)).notes).toHaveLength(2);
});
it("queues overlapping bundles and their links immediately on a device", async () => {
  const fixture = await resourceFixture();
  const queue = (type: string, payload: unknown) =>
    queueReplicaCommand({
      storage: fixture.s,
      repository: fixture.repo,
      path: "/api/knowledge",
      body: cmd(type, payload),
    });
  const a = await queue("saveMemoBundle", {
    title: "A",
    description: "",
    noteIds: [fixture.note],
    expectedVersion: 0,
  });
  const b = await queue("saveMemoBundle", {
    title: "B",
    description: "",
    noteIds: [fixture.note],
    expectedVersion: 0,
  });
  await queue("saveBundleLink", {
    sourceId: a.id,
    targetId: b.id,
    relation: "compares",
    reason: "비교",
    status: "accepted",
    expectedVersion: 0,
  });
  const value = (await fixture.repo.read("/api/whiteboard")) as any;
  expect(value.bundles).toHaveLength(2);
  expect(value.bundleLinks).toHaveLength(1);
  expect(value.connections).toHaveLength(0);
});
it("syncs new bundle rows into an already saved second device without scanning the whole library", async () => {
  const owner = randomUUID(),
    library = createLibraryStore(f.db);
  const note = (
    await library.mutate(owner, cmd("addNote", { content: "원본" }))
  ).id!;
  const a = createMemoryReplica(owner),
    b = createMemoryReplica(owner),
    ra = createReplicaRepository(a),
    rb = createReplicaRepository(b);
  const ta = sqlSyncTransport(f.db, owner),
    tb = sqlSyncTransport(f.db, owner),
    scan = vi.spyOn(tb, "scan");
  const ca = createReplicaCoordinator({ owner, storage: a, transport: ta }),
    cb = createReplicaCoordinator({ owner, storage: b, transport: tb });
  await ca.syncReplica({ reason: "test" });
  await cb.syncReplica({ reason: "test" });
  scan.mockClear();
  await queueReplicaCommand({
    storage: a,
    repository: ra,
    path: "/api/knowledge",
    body: cmd("saveMemoBundle", {
      title: "공유 생각",
      description: "다른 기기에서도",
      noteIds: [note],
      expectedVersion: 0,
    }),
  });
  expect((await ca.syncReplica({ reason: "test" })).phase).toBe("complete");
  expect((await cb.syncReplica({ reason: "test" })).phase).toBe("complete");
  const value = (await rb.read("/api/whiteboard")) as any;
  expect(value.bundles[0].title).toBe("공유 생각");
  expect(scan).not.toHaveBeenCalled();
  ra.close();
  rb.close();
});
it("restores a backup even after an original bundled memo was permanently removed", async () => {
  const owner = randomUUID(),
    library = createLibraryStore(f.db),
    store = createKnowledgeStore(f.db);
  const note = (
    await library.mutate(owner, cmd("addNote", { content: "삭제되는 원문" }))
  ).id!;
  await store.mutate(
    owner,
    cmd("saveMemoBundle", {
      title: "남기는 생각",
      description: "정리 보존",
      noteIds: [note],
      expectedVersion: 0,
    }),
  );
  await library.mutate(
    owner,
    cmd("deleteNote", { id: note, expectedVersion: 1 }),
  );
  await library.mutate(
    owner,
    cmd("emptyNoteTrash", { notes: [{ id: note, expectedVersion: 2 }] }),
  );
  const backup = await createLibraryBackup(f.db, owner),
    target = randomUUID(),
    destination = await testDatabase();
  expect(
    (await inspectLibraryBackup(destination.db, target, backup)).canRestore,
  ).toBe(true);
  await restoreLibraryBackup(destination.db, target, backup);
  expect(
    (await readWhiteboard(destination.db, target)).bundles?.[0],
  ).toMatchObject({
    title: "남기는 생각",
    description: "정리 보존",
    note_ids: [note],
  });
  await destination.pg.close();
});
it("reviews simultaneous creation of one bundle pair against the actual server relationship", async () => {
  const owner = randomUUID(),
    store = createKnowledgeStore(f.db),
    save = (title: string) =>
      store.mutate(
        owner,
        cmd("saveMemoBundle", {
          title,
          description: "",
          noteIds: [],
          expectedVersion: 0,
        }),
      );
  const a = await save("A"),
    b = await save("B"),
    s = createMemoryReplica(owner),
    repo = createReplicaRepository(s),
    coordinator = createReplicaCoordinator({
      owner,
      storage: s,
      transport: sqlSyncTransport(f.db, owner),
    });
  await coordinator.syncReplica({ reason: "test" });
  await queueReplicaCommand({
    storage: s,
    repository: repo,
    path: "/api/knowledge",
    body: cmd("saveBundleLink", {
      sourceId: a.id,
      targetId: b.id,
      relation: "compares",
      reason: "내가 적은 비교",
      status: "accepted",
      expectedVersion: 0,
    }),
  });
  const queued = (await s.listOutbox())[0];
  const server = await store.mutate(
    owner,
    cmd("saveBundleLink", {
      sourceId: b.id,
      targetId: a.id,
      relation: "related",
      reason: "다른 기기",
      status: "accepted",
      expectedVersion: 0,
    }),
  );
  await coordinator.syncReplica({ reason: "test" });
  const review = await loadReplicaConflict(s, queued.requestId);
  expect(review.latest).toMatchObject({ id: server.id, reason: "다른 기기" });
  await applyReplicaResolution(s, review, { choice: "mine" });
  expect((await coordinator.syncReplica({ reason: "test" })).conflicts).toBe(0);
  expect((await readWhiteboard(f.db, owner)).bundleLinks?.[0]).toMatchObject({
    id: server.id,
    relation: "compares",
    reason: "내가 적은 비교",
  });
  repo.close();
});
