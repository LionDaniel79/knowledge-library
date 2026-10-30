import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { mergeWritingProjects } from "../src/server/merge-writing-projects";
import { createKnowledgeStore } from "../src/server/knowledge-store";
import { createLibraryStore } from "../src/server/library-store";
import {
  emptyBoard,
  buildScene,
  type WhiteboardSnapshot,
} from "../src/lib/whiteboard";
import { readWhiteboard } from "../src/server/whiteboard-store";
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
async function sources(owner: string) {
  const store = createKnowledgeStore(f.db),
    result = [];
  for (const title of ["원본 하나", "원본 둘"]) {
    const { id } = await store.mutate(
      owner,
      cmd("createResearch", { title, kind: "thesis", question: "" }),
    );
    const data = emptyBoard();
    data.filter.q = title;
    await store.mutate(
      owner,
      cmd("saveWhiteboard", { boardId: id, expectedVersion: 0, data }),
    );
    result.push({
      id: id!,
      expectedTitle: title,
      expectedQuestion: "",
      expectedBoardVersion: 1,
    });
  }
  return result;
}
it("merges into a new project atomically, preserves originals, and includes only the source-visible unboxed notes", async () => {
  const owner = randomUUID(),
    library = createLibraryStore(f.db),
    store = createKnowledgeStore(f.db);
  const notes: string[] = [];
  for (const content of [
    "원본 하나의 메모",
    "원본 둘의 메모",
    "다른 글감 메모",
  ])
    notes.push((await library.mutate(owner, cmd("addNote", { content }))).id!);
  const selected = await sources(owner),
    before = await store.snapshot(owner);
  const originalBoards = (
    await f.db.query(
      "SELECT * FROM library_whiteboards WHERE owner_id=$1 ORDER BY id",
      [owner],
    )
  ).rows;
  const id = randomUUID();
  expect(
    await f.db.transaction((tx) =>
      mergeWritingProjects(
        tx,
        owner,
        { title: "합친 글감", sources: selected },
        id,
      ),
    ),
  ).toEqual({ id, version: 1 });
  const after = await store.snapshot(owner);
  expect(after.research).toHaveLength(3);
  for (const p of before.research) expect(after.research).toContainEqual(p);
  expect(
    (
      await f.db.query(
        "SELECT * FROM library_whiteboards WHERE owner_id=$1 AND id=ANY($2::uuid[]) ORDER BY id",
        [owner, selected.map((s) => s.id)],
      )
    ).rows,
  ).toEqual(originalBoards);
  const snapshot = await readWhiteboard(f.db, owner, id),
    board = snapshot.board!.data;
  expect(
    buildScene(snapshot as unknown as WhiteboardSnapshot, board)
      .nodes.map((n) => n.noteId)
      .sort(),
  ).toEqual(notes.slice(0, 2).sort());
  expect(board.writing?.excludedNoteIds).toEqual([notes[2]]);
  expect(
    (
      await f.db.query("SELECT * FROM library_memo_bundles WHERE owner_id=$1", [
        owner,
      ])
    ).rows,
  ).toHaveLength(0);
  expect(
    (
      await f.db.query(
        "SELECT action FROM library_revisions WHERE owner_id=$1 AND entity_id=$2 ORDER BY action",
        [owner, id],
      )
    ).rows,
  ).toEqual([{ action: "mergeWritingProjects" }, { action: "saveWhiteboard" }]);
});
it("ignores ordinary hidden memo flags in legacy writing sources while preserving explicit writing exclusions", async () => {
  const owner = randomUUID(),
    library = createLibraryStore(f.db),
    selected = await sources(owner);
  const notes: string[] = [];
  for (const content of ["원본 하나의 메모", "원본 둘의 메모"])
    notes.push((await library.mutate(owner, cmd("addNote", { content }))).id!);
  const originalBoards = selected.map((project, index) => {
    const data = emptyBoard();
    data.filter.q = project.expectedTitle;
    data.hiddenNoteIds = [...notes];
    if (index === 1) data.writing = { chapters: [] };
    return data;
  });
  for (const [index, project] of selected.entries())
    await f.db.query(
      "UPDATE library_whiteboards SET data=$3 WHERE owner_id=$1 AND id=$2",
      [owner, project.id, JSON.stringify(originalBoards[index])],
    );
  const id = randomUUID();
  await f.db.transaction((tx) =>
    mergeWritingProjects(
      tx,
      owner,
      { title: "옛 글감 합치기", sources: selected },
      id,
    ),
  );
  const snapshot = await readWhiteboard(f.db, owner, id);
  expect(
    buildScene(snapshot as unknown as WhiteboardSnapshot, snapshot.board!.data)
      .nodes.map((node) => node.noteId)
      .sort(),
  ).toEqual([...notes].sort());
  expect(snapshot.board!.data.writing?.excludedNoteIds).toEqual([]);
  for (const [index, project] of selected.entries())
    expect(
      (
        await f.db.query(
          "SELECT data FROM library_whiteboards WHERE owner_id=$1 AND id=$2",
          [owner, project.id],
        )
      ).rows[0].data,
    ).toEqual(originalBoards[index]);

  originalBoards[0].writing = { chapters: [], excludedNoteIds: [notes[0]] };
  await f.db.query(
    "UPDATE library_whiteboards SET data=$3 WHERE owner_id=$1 AND id=$2",
    [owner, selected[0].id, JSON.stringify(originalBoards[0])],
  );
  const excludedId = randomUUID();
  await f.db.transaction((tx) =>
    mergeWritingProjects(
      tx,
      owner,
      { title: "글감 제외 유지", sources: selected },
      excludedId,
    ),
  );
  const excluded = await readWhiteboard(f.db, owner, excludedId);
  expect(
    buildScene(
      excluded as unknown as WhiteboardSnapshot,
      excluded.board!.data,
    ).nodes.map((node) => node.noteId),
  ).toEqual([notes[1]]);
  expect(excluded.board!.data.writing?.excludedNoteIds).toEqual([notes[0]]);
});
it("rejects foreign or stale sources without creating a partial destination", async () => {
  const owner = randomUUID(),
    selected = await sources(owner),
    id = randomUUID();
  for (const [account, patch, status] of [
    [randomUUID(), {}, 404],
    [owner, { expectedBoardVersion: 0 }, 409],
    [owner, { expectedTitle: "옛 제목" }, 409],
  ] as const)
    await expect(
      f.db.transaction((tx) =>
        mergeWritingProjects(
          tx,
          account,
          {
            title: "합친 글감",
            sources: [{ ...selected[0], ...patch }, selected[1]],
          },
          id,
        ),
      ),
    ).rejects.toMatchObject({ status });
  expect(
    (await f.db.query("SELECT id FROM library_research WHERE id=$1", [id]))
      .rows,
  ).toHaveLength(0);
  expect(
    (await f.db.query("SELECT id FROM library_whiteboards WHERE id=$1", [id]))
      .rows,
  ).toHaveLength(0);
});
it("rejects fewer than two distinct projects", async () => {
  const owner = randomUUID(),
    selected = await sources(owner);
  for (const invalid of [[selected[0]], [selected[0], selected[0]]])
    await expect(
      f.db.transaction((tx) =>
        mergeWritingProjects(
          tx,
          owner,
          { title: "합친 글감", sources: invalid },
          randomUUID(),
        ),
      ),
    ).rejects.toBeTruthy();
});
it("preserves frozen legacy material and its placement when the memo is no longer active", async () => {
  const owner = randomUUID(),
    store = createKnowledgeStore(f.db),
    library = createLibraryStore(f.db),
    selected = await sources(owner);
  const note = (
    await library.mutate(owner, cmd("addNote", { content: "보관된 원문 메모" }))
  ).id!;
  const item = (
    await store.mutate(
      owner,
      cmd("addResearchNote", { researchId: selected[0].id, noteId: note }),
    )
  ).id!;
  await store.mutate(
    owner,
    cmd("placeResearchItem", {
      itemId: item,
      expectedVersion: 0,
      role: "evidence",
      section: "원문 단락",
      position: 7,
      comment: "인용 보존",
      state: "active",
    }),
  );
  await f.db.query(
    "INSERT INTO library_note_trash(owner_id,id) VALUES($1,$2)",
    [owner, note],
  );
  await f.db.query(
    "DELETE FROM library_whiteboards WHERE owner_id=$1 AND id=$2",
    [owner, selected[0].id],
  );
  selected[0].expectedBoardVersion = 0;
  const id = randomUUID();
  await f.db.transaction((tx) =>
    mergeWritingProjects(
      tx,
      owner,
      { title: "새 글감", sources: selected },
      id,
    ),
  );
  const after = await store.snapshot(owner),
    copy = after.items.find((i) => i.research_id === id)!;
  expect(copy).toBeTruthy();
  expect(copy.id).not.toBe(item);
  expect(copy.snapshot.note).toMatchObject({
    id: note,
    content: "보관된 원문 메모",
  });
  expect(after.placements.find((p) => p.id === copy.id)).toMatchObject({
    role: "evidence",
    section: "원문 단락",
    position: 7,
    comment: "인용 보존",
    state: "active",
  });
  expect(after.items.find((i) => i.id === item)).toBeTruthy();
  expect(
    (
      await f.db.query("SELECT id FROM library_notes WHERE owner_id=$1", [
        owner,
      ])
    ).rows,
  ).toEqual([{ id: note }]);
  const board = (
    await f.db.query(
      "SELECT data FROM library_whiteboards WHERE owner_id=$1 AND id=$2",
      [owner, id],
    )
  ).rows[0].data;
  expect(
    board.writing.chapters.flatMap((c: any) =>
      c.items.flatMap((i: any) => i.noteIds),
    ),
  ).toContain(note);
});
it("rolls back the new project and its revision if the destination board cannot be saved", async () => {
  const owner = randomUUID(),
    selected = await sources(owner),
    id = randomUUID();
  await expect(
    f.db.transaction((tx) =>
      mergeWritingProjects(
        {
          query: (sql, params) => {
            if (sql.startsWith("INSERT INTO library_whiteboards"))
              throw Error("fixture storage failure");
            return tx.query(sql, params);
          },
        },
        owner,
        { title: "합친 글감", sources: selected },
        id,
      ),
    ),
  ).rejects.toThrow("fixture storage failure");
  expect(
    (await f.db.query("SELECT id FROM library_research WHERE id=$1", [id]))
      .rows,
  ).toHaveLength(0);
  expect(
    (
      await f.db.query(
        "SELECT entity_id FROM library_revisions WHERE entity_id=$1",
        [id],
      )
    ).rows,
  ).toHaveLength(0);
  expect(
    (
      await f.db.query("SELECT id FROM library_research WHERE owner_id=$1", [
        owner,
      ])
    ).rows,
  ).toHaveLength(2);
});
