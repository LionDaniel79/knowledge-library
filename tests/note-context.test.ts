import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { createLibraryStore } from "../src/server/library-store";
import { readNoteTopics } from "../src/server/note-context";
import { prepareOptimistic } from "../src/client/replica/optimistic";
import type { ReplicaRepository } from "../src/client/replica/repository";
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
it("topic lookup only reads the active note and topics belonging to the signed-in owner", async () => {
  const owner = randomUUID(),
    other = randomUUID(),
    s = createLibraryStore(f.db);
  const n = await s.mutate(owner, cmd("addNote", { content: "내 기록" }));
  await topic(owner);
  await topic(other);
  expect(
    (await f.db.transaction((tx) => readNoteTopics(tx, owner, n.id))).topics,
  ).toHaveLength(1);
  await expect(
    f.db.transaction((tx) => readNoteTopics(tx, other, n.id)),
  ).rejects.toMatchObject({ status: 404 });
  await s.mutate(owner, cmd("deleteNote", { id: n.id, expectedVersion: 1 }));
  await expect(
    f.db.transaction((tx) => readNoteTopics(tx, owner, n.id)),
  ).rejects.toMatchObject({ status: 404 });
});
async function topic(owner: string) {
  const id = randomUUID();
  await f.db.query(
    "INSERT INTO library_topics(id,owner_id,name) VALUES($1,$2,'공감')",
    [id, owner],
  );
  return id;
}
it("creates the note, chosen topics and source-note connection in one idempotent save", async () => {
  const owner = randomUUID(),
    t = await topic(owner),
    s = createLibraryStore(f.db);
  const source = await s.mutate(
    owner,
    cmd("addNote", { content: "원래 생각" }),
  );
  const command = cmd("addNote", {
    content: "이어서 떠오른 생각",
    topicChanges: [{ topicId: t, status: "accepted", expectedVersion: 0 }],
    relatedNotes: [{ noteId: source.id }],
  });
  const result = await s.mutate(owner, command);
  expect(await s.mutate(owner, command)).toEqual(result);
  const ms = (
    await f.db.query(
      "SELECT * FROM library_topic_memberships WHERE owner_id=$1",
      [owner],
    )
  ).rows;
  expect(ms).toHaveLength(1);
  expect(ms[0]).toMatchObject({
    source_id: result.id,
    topic_id: t,
    status: "accepted",
    source_version: "1",
  });
  const links = (
    await f.db.query("SELECT * FROM library_connections WHERE owner_id=$1", [
      owner,
    ])
  ).rows;
  expect(links).toHaveLength(1);
  expect(new Set([links[0].source_id, links[0].target_id])).toEqual(
    new Set([result.id, source.id]),
  );
  expect(links[0].status).toBe("accepted");
});
it("rolls back the note when a selected topic belongs to someone else", async () => {
  const owner = randomUUID(),
    otherTopic = await topic(randomUUID()),
    s = createLibraryStore(f.db);
  await expect(
    s.mutate(
      owner,
      cmd("addNote", {
        content: "저장되면 안 되는 기록",
        topicChanges: [
          { topicId: otherTopic, status: "accepted", expectedVersion: 0 },
        ],
      }),
    ),
  ).rejects.toMatchObject({ status: 404 });
  expect(
    (
      await f.db.query(
        "SELECT count(*)::int AS n FROM library_notes WHERE owner_id=$1",
        [owner],
      )
    ).rows[0].n,
  ).toBe(0);
});
it("rejects a stale topic edit without saving a changed memo body", async () => {
  const owner = randomUUID(),
    t = await topic(owner),
    s = createLibraryStore(f.db);
  const n = await s.mutate(
    owner,
    cmd("addNote", {
      content: "처음 생각",
      topicChanges: [{ topicId: t, status: "accepted", expectedVersion: 0 }],
    }),
  );
  await expect(
    s.mutate(
      owner,
      cmd("editNote", {
        id: n.id,
        expectedVersion: 1,
        content: "바뀐 생각",
        topicChanges: [{ topicId: t, status: "rejected", expectedVersion: 9 }],
      }),
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect(
    (await f.db.query("SELECT content FROM library_notes WHERE id=$1", [n.id]))
      .rows[0].content,
  ).toBe("처음 생각");
});
it("preserves topic metadata for old callers and only changes explicitly supplied classifications", async () => {
  const owner = randomUUID(),
    t = await topic(owner),
    s = createLibraryStore(f.db);
  const n = await s.mutate(
    owner,
    cmd("addNote", {
      content: "원래 기록",
      topicChanges: [{ topicId: t, status: "accepted", expectedVersion: 0 }],
    }),
  );
  await s.mutate(
    owner,
    cmd("editNote", { id: n.id, expectedVersion: 1, content: "수정한 기록" }),
  );
  expect(
    (
      await f.db.query(
        "SELECT status,version FROM library_topic_memberships WHERE source_id=$1",
        [n.id],
      )
    ).rows[0],
  ).toMatchObject({ status: "accepted", version: 1 });
  await s.mutate(
    owner,
    cmd("editNote", {
      id: n.id,
      expectedVersion: 2,
      content: "수정한 기록",
      topicChanges: [{ topicId: t, status: "rejected", expectedVersion: 1 }],
    }),
  );
  expect(
    (
      await f.db.query(
        "SELECT status,version FROM library_topic_memberships WHERE source_id=$1",
        [n.id],
      )
    ).rows[0],
  ).toMatchObject({ status: "rejected", version: 2 });
});
it("does not create a new memo linked to a trashed or foreign source", async () => {
  const owner = randomUUID(),
    s = createLibraryStore(f.db),
    source = await s.mutate(owner, cmd("addNote", { content: "휴지통 원본" }));
  await s.mutate(
    owner,
    cmd("deleteNote", { id: source.id, expectedVersion: 1 }),
  );
  await expect(
    s.mutate(
      owner,
      cmd("addNote", {
        content: "관련 생각",
        relatedNotes: [{ noteId: source.id }],
      }),
    ),
  ).rejects.toMatchObject({ status: 404 });
  expect(
    (
      await f.db.query(
        "SELECT count(*)::int AS n FROM library_notes WHERE owner_id=$1",
        [owner],
      )
    ).rows[0].n,
  ).toBe(1);
});
it("prepares one local note save with the same child identifiers as the server", async () => {
  const owner = randomUUID(),
    t = await topic(owner),
    s = createLibraryStore(f.db),
    source = await s.mutate(owner, cmd("addNote", { content: "출발 기록" }));
  const body = {
    ...cmd("addNote", {
      content: "새 생각",
      topicChanges: [{ topicId: t, status: "accepted", expectedVersion: 0 }],
      relatedNotes: [{ noteId: source.id }],
    }),
    entityId: randomUUID(),
  };
  const repository = {
    raw: async (entity: string, id: string) =>
      (
        await f.db.query(
          `SELECT * FROM ${entity} WHERE owner_id=$1 AND id=$2`,
          [owner, id],
        )
      ).rows[0],
    all: async (entity: string) =>
      (await f.db.query(`SELECT * FROM ${entity} WHERE owner_id=$1`, [owner]))
        .rows,
  } as unknown as ReplicaRepository;
  const local = await prepareOptimistic(
    repository,
    "/api/library",
    body,
    new Date().toISOString(),
  );
  expect(local.entityId).toBe(body.entityId);
  expect(
    local.effects.filter((e) => e.entity === "library_topic_memberships"),
  ).toHaveLength(1);
  expect(
    local.effects.filter((e) => e.entity === "library_connections"),
  ).toHaveLength(1);
  await s.mutate(owner, body);
  for (const entity of [
    "library_topic_memberships",
    "library_connections",
  ] as const) {
    const predicted = local.effects.find((e) => e.entity === entity)!.after!;
    const remote = (
      await f.db.query(`SELECT * FROM ${entity} WHERE owner_id=$1`, [owner])
    ).rows[0];
    expect(remote.id).toBe(predicted.id);
    expect(remote.version).toBe(predicted.version);
  }
});
