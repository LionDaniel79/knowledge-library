import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { createKnowledgeStore } from "../src/server/knowledge-store";
import { createLibraryStore } from "../src/server/library-store";
import { readWhiteboard } from "../src/server/whiteboard-store";
import { readThoughtBoxes } from "../src/server/thought-boxes";
import { createMemoryReplica } from "../src/client/replica/memory-storage";
import { createReplicaRepository } from "../src/client/replica/repository";
import { createReplicaCoordinator } from "../src/client/replica/coordinator";
import { queueReplicaCommand } from "../src/client/replica/outbox";
import { sqlSyncTransport } from "./helpers/sync-transport";
import {
  emptyBoard,
  buildScene,
  WHITEBOARD_ID,
  type WhiteboardSnapshot,
} from "../src/lib/whiteboard";
import {
  referenceThoughtBox,
  projectSharedBoxes,
} from "../src/lib/shared-thought-boxes";

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

async function fixture() {
  const owner = randomUUID(),
    store = createKnowledgeStore(f.db),
    library = createLibraryStore(f.db);
  const note = (
    await library.mutate(owner, cmd("addNote", { content: "보존할 원문" }))
  ).id!;
  const save = (title: string) =>
    store.mutate(
      owner,
      cmd("saveMemoBundle", {
        title,
        description: "",
        noteIds: [note],
        expectedVersion: 0,
      }),
    );
  const a = await save("지울 묶음"),
    b = await save("남길 묶음");
  const link = await store.mutate(
    owner,
    cmd("saveBundleLink", {
      sourceId: a.id,
      targetId: b.id,
      relation: "related",
      reason: "연관",
      status: "accepted",
      expectedVersion: 0,
    }),
  );
  const research = await store.mutate(
    owner,
    cmd("createResearch", { title: "글감", kind: "thesis", question: "" }),
  );
  const source = (await readWhiteboard(
    f.db,
    owner,
  )) as unknown as WhiteboardSnapshot;
  let board = referenceThoughtBox(
    emptyBoard(),
    source.bundles!.find((x) => x.id === a.id)!,
    source,
  );
  board = referenceThoughtBox(
    board,
    source.bundles!.find((x) => x.id === b.id)!,
    source,
  );
  for (const boardId of [WHITEBOARD_ID, research.id!])
    await store.mutate(
      owner,
      cmd("saveWhiteboard", {
        boardId,
        data: board,
        expectedVersion: 0,
      }),
    );
  return { owner, store, library, note, a, b, link, research, board };
}

it("deletes one canonical bundle and its accepted links, preserving notes and both boards' other boxes", async () => {
  const x = await fixture(),
    action = cmd("archiveMemoBundle", { id: x.a.id, expectedVersion: 1 });
  await expect(x.store.mutate("foreign-owner", action)).rejects.toMatchObject({
    status: 404,
  });
  await expect(
    x.store.mutate(
      x.owner,
      cmd("archiveMemoBundle", { id: x.a.id, expectedVersion: 2 }),
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect(await x.store.mutate(x.owner, action)).toMatchObject({
    id: x.a.id,
    version: 2,
  });
  expect(await x.store.mutate(x.owner, action)).toMatchObject({
    id: x.a.id,
    version: 2,
  });
  const source = await readWhiteboard(f.db, x.owner);
  expect(source.bundleLinks).toEqual([
    expect.objectContaining({ id: x.link.id, status: "rejected", version: 2 }),
  ]);
  expect(
    source.bundles!.find((b) => b.id === x.a.id)?.archived_at,
  ).toBeTruthy();
  expect((await x.library.snapshot(x.owner)).notes).toHaveLength(1);
  expect(
    (await readThoughtBoxes(f.db, x.owner)).items.map((b) => b.id),
  ).toEqual([x.b.id]);
  for (const boardId of [WHITEBOARD_ID, x.research.id!]) {
    const stale = (await readWhiteboard(
      f.db,
      x.owner,
      boardId,
    )) as unknown as WhiteboardSnapshot;
    expect(
      projectSharedBoxes(stale.board!.data, stale).writing!.chapters.map(
        (c) => c.bundleId,
      ),
    ).toEqual([x.b.id]);
    expect(
      buildScene(stale, stale.board!.data).nodes.map((c) => c.chapterId),
    ).toEqual([x.b.id]);
  }
  await x.store.mutate(x.owner, cmd("promoteThoughtBoxes", {}));
  expect(
    (await readThoughtBoxes(f.db, x.owner)).items.map((b) => b.id),
  ).toEqual([x.b.id]);
  await expect(
    x.store.mutate(
      x.owner,
      cmd("saveMemoBundle", {
        id: x.a.id,
        title: "되살리지 않음",
        description: "",
        noteIds: [x.note],
        expectedVersion: 2,
      }),
    ),
  ).rejects.toMatchObject({ status: 409 });
});

it("queues canonical deletion offline, rejects its links immediately, and syncs deletion to another device", async () => {
  const x = await fixture(),
    storage = createMemoryReplica(x.owner),
    second = createMemoryReplica(x.owner);
  const repo = createReplicaRepository(storage),
    other = createReplicaRepository(second);
  const coordinator = createReplicaCoordinator({
    owner: x.owner,
    storage,
    transport: sqlSyncTransport(f.db, x.owner),
  });
  const peer = createReplicaCoordinator({
    owner: x.owner,
    storage: second,
    transport: sqlSyncTransport(f.db, x.owner),
  });
  try {
    await coordinator.syncReplica({ reason: "test" });
    await peer.syncReplica({ reason: "test" });
    const action = cmd("archiveMemoBundle", { id: x.a.id, expectedVersion: 1 });
    const queue = () =>
      queueReplicaCommand({
        storage,
        repository: repo,
        path: "/api/knowledge",
        body: action,
      });
    expect(await queue()).toMatchObject({ id: x.a.id, version: 2 });
    expect(await queue()).toMatchObject({ id: x.a.id, version: 2 });
    expect(await repo.raw("library_bundle_links", x.link.id!)).toMatchObject({
      status: "rejected",
      version: 2,
    });
    expect(
      ((await repo.read("/api/thought-boxes")) as any).items.map(
        (b: any) => b.id,
      ),
    ).toEqual([x.b.id]);
    expect(await repo.raw("library_notes", x.note)).toMatchObject({
      content: "보존할 원문",
    });
    expect((await coordinator.syncReplica({ reason: "test" })).conflicts).toBe(
      0,
    );
    expect((await peer.syncReplica({ reason: "test" })).conflicts).toBe(0);
    expect(
      ((await other.read("/api/thought-boxes")) as any).items.map(
        (b: any) => b.id,
      ),
    ).toEqual([x.b.id]);
    expect(await other.raw("library_bundle_links", x.link.id!)).toMatchObject({
      status: "rejected",
      version: 2,
    });
    expect(await storage.listOutbox()).toHaveLength(0);
  } finally {
    repo.close();
    other.close();
  }
});
