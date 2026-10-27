import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { createLibraryStore } from "../src/server/library-store";
import { createKnowledgeStore } from "../src/server/knowledge-store";
import {
  readWhiteboard,
  readWhiteboardVisibility,
} from "../src/server/whiteboard-store";
import { emptyBoard, WHITEBOARD_ID } from "../src/lib/whiteboard";
let fixture: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  fixture = await testDatabase();
});
afterAll(async () => {
  await fixture?.pg.close();
});
const command = (type: string, payload: unknown) => ({
  requestId: randomUUID(),
  type,
  payload,
});
it("saves reversible owner-only visibility without losing layout, old-client saves or other hidden notes", async () => {
  const owner = randomUUID(),
    library = createLibraryStore(fixture.db),
    store = createKnowledgeStore(fixture.db);
  const a = await library.mutate(
      owner,
      command("addNote", { content: "안전하게 보존할 메모" }),
    ),
    b = await library.mutate(
      owner,
      command("addNote", { content: "다른 메모" }),
    );
  const data = emptyBoard();
  data.filter.q = "내 배치";
  await store.mutate(
    owner,
    command("saveWhiteboard", { data, expectedVersion: 0 }),
  );
  const hide = command("setWhiteboardNoteVisibility", {
    noteId: a.id,
    visible: false,
  });
  const first = await store.mutate(owner, hide);
  await store.mutate(owner, hide);
  expect(await readWhiteboardVisibility(fixture.db, owner, a.id)).toEqual({
    visible: false,
  });
  await store.mutate(
    owner,
    command("setWhiteboardNoteVisibility", { noteId: b.id, visible: false }),
  );
  const oldClient = emptyBoard();
  oldClient.hiddenNoteIds = [];
  oldClient.filter.q = "새 배치";
  await store.mutate(
    owner,
    command("saveWhiteboard", {
      data: oldClient,
      expectedVersion: (first.version ?? 0) + 1,
    }),
  );
  await store.mutate(
    owner,
    command("setWhiteboardNoteVisibility", { noteId: a.id, visible: true }),
  );
  const latest = await readWhiteboard(fixture.db, owner);
  expect(latest.board?.data.filter.q).toBe("새 배치");
  expect(latest.board?.data.hiddenNoteIds).toEqual([b.id]);
  expect(latest.notes).toHaveLength(2);
  await expect(
    store.mutate(
      randomUUID(),
      command("setWhiteboardNoteVisibility", { noteId: a.id, visible: false }),
    ),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    readWhiteboardVisibility(fixture.db, randomUUID(), a.id),
  ).rejects.toMatchObject({ status: 404 });
});
it("saves board versions and rejects stale edits without overwriting the owner's board", async () => {
  const store = createKnowledgeStore(fixture.db),
    owner = randomUUID(),
    data = emptyBoard();
  data.filter.q = "소중한 생각";
  const request = command("saveWhiteboard", { data, expectedVersion: 0 });
  expect(await store.mutate(owner, request)).toMatchObject({
    id: WHITEBOARD_ID,
    version: 1,
  });
  expect(await store.mutate(owner, request)).toMatchObject({ version: 1 });
  await expect(
    store.mutate(
      owner,
      command("saveWhiteboard", { data: emptyBoard(), expectedVersion: 0 }),
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect((await readWhiteboard(fixture.db, owner)).board?.data.filter.q).toBe(
    "소중한 생각",
  );
  expect((await readWhiteboard(fixture.db, randomUUID())).board).toBeNull();
});
it("links real notes, recognizes the reverse pair and preserves an existing relation and reason", async () => {
  const owner = randomUUID(),
    library = createLibraryStore(fixture.db),
    store = createKnowledgeStore(fixture.db);
  const a = await library.mutate(
      owner,
      command("addNote", { content: "첫번째 내 생각" }),
    ),
    b = await library.mutate(
      owner,
      command("addNote", { content: "두번째 내 생각" }),
    );
  const created = await store.mutate(
    owner,
    command("connectWhiteboardNotes", { sourceId: a.id, targetId: b.id }),
  );
  const reverse = await store.mutate(
    owner,
    command("connectWhiteboardNotes", { sourceId: b.id, targetId: a.id }),
  );
  expect(reverse.id).toBe(created.id);
  expect(reverse.changed).toBe(false);
  await store.mutate(
    owner,
    command("editConnection", {
      id: created.id,
      expectedVersion: 1,
      relation: "challenges",
      reason: "내가 판단한 반론",
      status: "rejected",
    }),
  );
  const restored = await store.mutate(
    owner,
    command("connectWhiteboardNotes", { sourceId: a.id, targetId: b.id }),
  );
  expect(restored.connection).toMatchObject({
    relation: "challenges",
    reason: "내가 판단한 반론",
  });
  const result = await readWhiteboard(fixture.db, owner);
  expect(result.connections).toHaveLength(1);
  expect(result.connections[0]).toMatchObject({
    status: "accepted",
    relation: "challenges",
    reason: "내가 판단한 반론",
    version: 3,
  });
  await expect(
    store.mutate(
      randomUUID(),
      command("connectWhiteboardNotes", { sourceId: a.id, targetId: b.id }),
    ),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    store.mutate(
      owner,
      command("connectWhiteboardNotes", { sourceId: a.id, targetId: a.id }),
    ),
  ).rejects.toBeDefined();
});
it("does not connect notes in the trash and does not expose them on the board", async () => {
  const owner = randomUUID(),
    library = createLibraryStore(fixture.db),
    store = createKnowledgeStore(fixture.db);
  const a = await library.mutate(
      owner,
      command("addNote", { content: "휴지통으로 보낼 생각" }),
    ),
    b = await library.mutate(
      owner,
      command("addNote", { content: "남길 생각" }),
    );
  await library.mutate(
    owner,
    command("deleteNote", { id: a.id, expectedVersion: 1 }),
  );
  await expect(
    store.mutate(
      owner,
      command("connectWhiteboardNotes", { sourceId: a.id, targetId: b.id }),
    ),
  ).rejects.toMatchObject({ status: 404 });
  expect(
    (await readWhiteboard(fixture.db, owner)).notes.map((n) => n.id),
  ).toEqual([b.id]);
});
