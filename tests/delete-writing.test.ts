import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { testDatabase } from "./helpers/database";
import { createLibraryStore } from "../src/server/library-store";
import { createKnowledgeStore } from "../src/server/knowledge-store";
import { emptyBoard } from "../src/lib/whiteboard";
import { resourceFixture } from "./helpers/replica-resources";
import { queueReplicaCommand } from "../src/client/replica/outbox";
let f: Awaited<ReturnType<typeof testDatabase>>;
const command = (type: string, payload: unknown) => ({
  requestId: randomUUID(),
  type,
  payload,
});
beforeAll(async () => {
  f = await testDatabase();
});
afterAll(async () => {
  await f?.pg.close();
});
it("deletes only the chosen writing project and its layout/material copies, preserving notes and relationships", async () => {
  const owner = randomUUID(),
    store = createKnowledgeStore(f.db),
    library = createLibraryStore(f.db);
  const a = (
      await library.mutate(
        owner,
        command("addNote", { content: "원래 기록 A" }),
      )
    ).id!,
    b = (
      await library.mutate(
        owner,
        command("addNote", { content: "원래 기록 B" }),
      )
    ).id!;
  await store.mutate(
    owner,
    command("connectWhiteboardNotes", { sourceId: a, targetId: b }),
  );
  const project = (
    await store.mutate(
      owner,
      command("createResearch", {
        title: "지울 글감",
        kind: "thesis",
        question: "질문",
      }),
    )
  ).id!;
  const kept = (
    await store.mutate(
      owner,
      command("createResearch", {
        title: "남길 글감",
        kind: "thesis",
        question: "",
      }),
    )
  ).id!;
  const item = (
    await store.mutate(
      owner,
      command("addResearchNote", { researchId: project, noteId: a }),
    )
  ).id!;
  await store.mutate(
    owner,
    command("placeResearchItem", {
      itemId: item,
      expectedVersion: 0,
      role: "claim",
      section: "서론",
      position: 1,
      comment: "해석",
      state: "active",
    }),
  );
  for (const id of [project, kept])
    await store.mutate(
      owner,
      command("saveWhiteboard", {
        boardId: id,
        expectedVersion: 0,
        data: emptyBoard(),
      }),
    );
  const before = await library.snapshot(owner),
    deletion = command("deleteResearch", {
      id: project,
      expectedTitle: "지울 글감",
      expectedQuestion: "질문",
      expectedBoardVersion: 1,
    });
  expect(await store.mutate(owner, deletion)).toMatchObject({
    id: project,
    deleted: true,
  });
  expect(await store.mutate(owner, deletion)).toMatchObject({
    id: project,
    deleted: true,
  });
  const state = await store.snapshot(owner);
  expect(state.research.map((p) => p.id)).toEqual([kept]);
  expect(state.items).toHaveLength(0);
  expect(state.placements).toHaveLength(0);
  expect(state.connections).toHaveLength(1);
  expect((await library.snapshot(owner)).notes).toEqual(before.notes);
  expect(
    (
      await f.db.query("SELECT id FROM library_whiteboards WHERE owner_id=$1", [
        owner,
      ])
    ).rows.map((r) => r.id),
  ).toEqual([kept]);
  const archive = (
    await f.db.query(
      "SELECT before_data FROM library_revisions WHERE owner_id=$1 AND entity_id=$2 AND action='deleteResearch'",
      [owner, project],
    )
  ).rows[0].before_data;
  expect(archive.research.title).toBe("지울 글감");
  expect(archive.items).toHaveLength(1);
  expect(archive.board).toBeTruthy();
  await expect(
    store.mutate(
      owner,
      command("saveWhiteboard", {
        boardId: project,
        data: emptyBoard(),
        expectedVersion: 0,
      }),
    ),
  ).rejects.toMatchObject({ status: 404 });
});
it("rejects another account and a stale confirmation without removing any project", async () => {
  const owner = randomUUID(),
    store = createKnowledgeStore(f.db),
    id = (
      await store.mutate(
        owner,
        command("createResearch", {
          title: "현재 제목",
          kind: "thesis",
          question: "",
        }),
      )
    ).id!;
  await expect(
    store.mutate(
      randomUUID(),
      command("deleteResearch", {
        id,
        expectedTitle: "현재 제목",
        expectedQuestion: "",
        expectedBoardVersion: 0,
      }),
    ),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    store.mutate(
      owner,
      command("deleteResearch", {
        id,
        expectedTitle: "이전 제목",
        expectedQuestion: "",
        expectedBoardVersion: 0,
      }),
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect((await store.snapshot(owner)).research.map((p) => p.id)).toEqual([id]);
  await store.mutate(
    owner,
    command("saveWhiteboard", {
      boardId: id,
      expectedVersion: 0,
      data: emptyBoard(),
    }),
  );
  await expect(
    store.mutate(
      owner,
      command("deleteResearch", {
        id,
        expectedTitle: "현재 제목",
        expectedQuestion: "",
        expectedBoardVersion: 0,
      }),
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect((await store.snapshot(owner)).research.map((p) => p.id)).toEqual([id]);
});
it("removes a writing project from device views immediately and queues deletion for synchronization", async () => {
  const fixture = await resourceFixture();
  const project = (await fixture.repo.raw(
    "library_research",
    fixture.research,
  ))!;
  const notes = await fixture.repo.all("library_notes");
  const result = await queueReplicaCommand({
    storage: fixture.s,
    repository: fixture.repo,
    path: "/api/knowledge",
    body: command("deleteResearch", {
      id: project.id,
      expectedTitle: project.title,
      expectedQuestion: project.question,
      expectedBoardVersion: 0,
    }),
  });
  expect(result).toMatchObject({ id: project.id, deleted: true, queued: true });
  expect(
    await fixture.repo.raw("library_research", project.id),
  ).toBeUndefined();
  expect(await fixture.repo.all("library_notes")).toEqual(notes);
  expect((await fixture.s.listOutbox())[0].entityId).toBe(project.id);
  await fixture.repo.close();
  await fixture.s.close();
});
it("allows scoped removal with the real restricted runtime role without broad DELETE privileges", async () => {
  const fixture = await testDatabase();
  try {
    await fixture.pg.exec(
      await readFile("db/operations/provision-web-runtime.sql", "utf8"),
    );
    await fixture.pg.exec("SET SESSION AUTHORIZATION library_web_runtime");
    const owner = randomUUID(),
      store = createKnowledgeStore(fixture.db);
    const id = (
      await store.mutate(
        owner,
        command("createResearch", {
          title: "권한 검사",
          question: "",
          kind: "thesis",
        }),
      )
    ).id!;
    await store.mutate(
      owner,
      command("saveWhiteboard", {
        boardId: id,
        expectedVersion: 0,
        data: emptyBoard(),
      }),
    );
    await store.mutate(
      owner,
      command("deleteResearch", {
        id,
        expectedTitle: "권한 검사",
        expectedQuestion: "",
        expectedBoardVersion: 1,
      }),
    );
    expect((await store.snapshot(owner)).research).toHaveLength(0);
    expect(
      (
        await fixture.db.query(
          "SELECT has_table_privilege('library_web_runtime','library_whiteboards','DELETE') AS direct",
        )
      ).rows[0].direct,
    ).toBe(false);
  } finally {
    await fixture.pg.close();
  }
});
