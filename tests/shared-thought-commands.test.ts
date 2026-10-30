import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { resourceFixture } from "./helpers/replica-resources";
import { createLibraryStore } from "../src/server/library-store";
import { createKnowledgeStore } from "../src/server/knowledge-store";
import { readWhiteboard } from "../src/server/whiteboard-store";
import { queueReplicaCommand } from "../src/client/replica/outbox";
import {
  emptyBoard,
  buildScene,
  type WhiteboardSnapshot,
} from "../src/lib/whiteboard";
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
it("persists connection titles, preserves them for older clients, and rejects stale or foreign edits", async () => {
  const owner = randomUUID(),
    library = createLibraryStore(f.db),
    store = createKnowledgeStore(f.db);
  const a = await library.mutate(owner, cmd("addNote", { content: "첫 생각" })),
    b = await library.mutate(owner, cmd("addNote", { content: "다음 생각" }));
  const c = await store.mutate(
    owner,
    cmd("connectWhiteboardNotes", { sourceId: a.id, targetId: b.id }),
  );
  const edit = {
    id: c.id,
    expectedVersion: 1,
    title: "연결 제목",
    relation: "related",
    reason: "연결 이유",
    status: "accepted",
  };
  const request = cmd("editConnection", edit);
  await store.mutate(owner, request);
  expect(await store.mutate(owner, request)).toMatchObject({ version: 2 });
  expect((await readWhiteboard(f.db, owner)).connections[0]).toMatchObject({
    title: "연결 제목",
    version: 2,
  });
  await expect(
    store.mutate(owner, cmd("editConnection", edit)),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    store.mutate(
      "other",
      cmd("editConnection", { ...edit, expectedVersion: 2 }),
    ),
  ).rejects.toMatchObject({ status: 404 });
  const { title: _title, ...legacy } = edit;
  await store.mutate(
    owner,
    cmd("editConnection", {
      ...legacy,
      expectedVersion: 2,
      reason: "이유 보완",
    }),
  );
  expect((await readWhiteboard(f.db, owner)).connections[0]).toMatchObject({
    title: "연결 제목",
    reason: "이유 보완",
    version: 3,
  });
  await store.mutate(
    owner,
    cmd("editConnection", { ...edit, expectedVersion: 3, title: "" }),
  );
  expect((await readWhiteboard(f.db, owner)).connections[0].title).toBe("");
});
it("queues connection titles on the device with the same preserve/clear semantics", async () => {
  const d = await resourceFixture();
  try {
    const send = (type: string, payload: unknown) =>
      queueReplicaCommand({
        storage: d.s,
        repository: d.repo,
        path: "/api/knowledge",
        body: cmd(type, payload),
      });
    const other = await queueReplicaCommand({
      storage: d.s,
      repository: d.repo,
      path: "/api/library",
      body: cmd("addNote", { content: "다음 메모" }),
    });
    const c: any = await send("connectWhiteboardNotes", {
      sourceId: d.note,
      targetId: other.id,
    });
    const edit = {
      id: c.id,
      expectedVersion: 1,
      title: "로컬 연결",
      relation: "related",
      reason: "이유",
      status: "accepted",
    };
    await send("editConnection", edit);
    expect((await d.repo.raw("library_connections", c.id))?.title).toBe(
      "로컬 연결",
    );
    const { title: _title, ...legacy } = edit;
    await send("editConnection", { ...legacy, expectedVersion: 2 });
    expect((await d.repo.raw("library_connections", c.id))?.title).toBe(
      "로컬 연결",
    );
    await send("editConnection", { ...edit, expectedVersion: 3, title: "" });
    expect((await d.repo.raw("library_connections", c.id))?.title).toBe("");
  } finally {
    d.repo.close();
  }
});
it("merges offline writing projects while retaining originals, frozen material and shared box identity", async () => {
  const d = await resourceFixture();
  try {
    const send = (type: string, payload: unknown) =>
      queueReplicaCommand({
        storage: d.s,
        repository: d.repo,
        path: "/api/knowledge",
        body: cmd(type, payload),
      });
    const canonical: any = await send("saveMemoBundle", {
      expectedVersion: 0,
      title: "원본 묶음",
      description: "원본 내용",
      noteIds: [d.note],
    });
    const a: any = await send("createResearch", {
        title: "글감 A",
        kind: "thesis",
        question: "",
      }),
      b: any = await send("createResearch", {
        title: "글감 B",
        kind: "thesis",
        question: "",
      });
    await send("addResearchNote", { researchId: a.id, noteId: d.note });
    const data = emptyBoard();
    data.hiddenNoteIds = [d.note];
    data.writing = { chapters: [] }; // Old writing layouts must ignore ordinary hiding.
    await send("saveWhiteboard", { boardId: a.id, expectedVersion: 0, data });
    await send("saveWhiteboard", { boardId: b.id, expectedVersion: 0, data });
    const originalA = structuredClone(
      await d.repo.raw("library_whiteboards", a.id),
    );
    const merged: any = await send("mergeWritingProjects", {
      title: "새 합친 글감",
      sources: [
        {
          id: a.id,
          expectedTitle: "글감 A",
          expectedQuestion: "",
          expectedBoardVersion: 1,
        },
        {
          id: b.id,
          expectedTitle: "글감 B",
          expectedQuestion: "",
          expectedBoardVersion: 1,
        },
      ],
    });
    const view = (await d.repo.read(
      `/api/whiteboard?boardId=${merged.id}`,
    )) as WhiteboardSnapshot;
    expect(
      buildScene(view, view.board!.data).nodes.map((n) => n.noteId),
    ).toContain(d.note);
    expect(await d.repo.raw("library_whiteboards", a.id)).toEqual(originalA);
    expect(await d.repo.raw("library_research", b.id)).toMatchObject({
      title: "글감 B",
    });
    expect(
      await d.repo.raw("library_memo_bundles", canonical.id),
    ).toMatchObject({ title: "원본 묶음", version: 1 });
    const research: any = await d.repo.read("/api/knowledge");
    expect(
      research.items.filter((i: any) => i.research_id === merged.id),
    ).toHaveLength(1);
  } finally {
    d.repo.close();
  }
});
