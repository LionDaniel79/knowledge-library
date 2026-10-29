import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  buildScene,
  emptyBoard,
  boardSchema,
  type WhiteboardSnapshot,
} from "../src/lib/whiteboard";
import { bundleBoard } from "../src/lib/thought-bundle-board";
import {
  addChapter,
  addChapterMaterial,
  moveChapter,
  exportWritingBoard,
} from "../src/lib/writing-board";
it("shows a shared original memo in two independently positioned bundles and draws only explicit bundle links", () => {
  const id = randomUUID(),
    a = randomUUID(),
    b = randomUUID();
  const source = {
    notes: [{ id, title: "기록", content: "본문" }],
    books: [],
    topics: [],
    memberships: [],
    connections: [],
    bundles: [
      {
        id: a,
        title: "A",
        description: "",
        note_ids: [id],
        version: 1,
        archived_at: null,
      },
      {
        id: b,
        title: "B",
        description: "",
        note_ids: [id],
        version: 1,
        archived_at: null,
      },
    ],
    bundleLinks: [
      {
        id: randomUUID(),
        source_id: a,
        target_id: b,
        status: "accepted",
        relation: "related",
        reason: "",
        version: 1,
      },
    ],
  } as unknown as WhiteboardSnapshot;
  const board = emptyBoard();
  board.groupPositions["bundle:" + a] = { x: -400, y: 10 };
  board.groupPositions["bundle:" + b] = { x: 300, y: 20 };
  const view = bundleBoard(source, board),
    scene = buildScene(source, view);
  expect(scene.groups.map((g) => g.id)).toEqual(["bundle:" + a, "bundle:" + b]);
  expect(scene.nodes).toHaveLength(2);
  expect(scene.nodes[0].note).toBe(scene.nodes[1].note);
  expect(scene.nodes[0].x).not.toBe(scene.nodes[1].x);
  expect(view.links).toEqual([
    { source: "bundle:" + a, target: "bundle:" + b },
  ]);
  expect(boardSchema.safeParse(view).success).toBe(true);
  source.bundleLinks = [];
  expect(bundleBoard(source, view).links).toHaveLength(0);
});
it("exports current bundle membership and current original note text", () => {
  const a = randomUUID(),
    b = randomUUID(),
    bundle = randomUUID(),
    chapter = randomUUID();
  const source = {
    notes: [
      { id: a, title: "과거", content: "이전" },
      { id: b, title: "현재", content: "고친 원문" },
    ],
    books: [],
    topics: [],
    memberships: [],
    connections: [],
    bundles: [{ id: bundle, title: "생각", note_ids: [a] }],
  } as unknown as WhiteboardSnapshot;
  let board = addChapter(emptyBoard(), chapter);
  board = addChapterMaterial(
    board,
    chapter,
    {
      id: randomUUID(),
      kind: "notes",
      label: "생각",
      order: 1,
      noteIds: [a],
      groupIds: ["bundle:" + bundle],
    },
    source,
  );
  source.bundles![0].note_ids = [b];
  source.bundles![0].title = "바뀐 생각 묶음 이름";
  const text = exportWritingBoard("글", board, source, "md");
  expect(text).toContain("고친 원문");
  expect(text).toContain("바뀐 생각 묶음 이름");
  expect(text).not.toContain("이전");
});
it("placing an individual memo in a chapter leaves its other bundle instance in place", () => {
  const n = randomUUID(),
    g = randomUUID(),
    c = randomUUID(),
    item = randomUUID();
  const source = {
    notes: [{ id: n, title: "메모", content: "내용" }],
    books: [],
    topics: [],
    memberships: [],
    connections: [],
    bundles: [{ id: g, title: "묶음", note_ids: [n] }],
  } as unknown as WhiteboardSnapshot;
  let board = addChapter(emptyBoard(), c);
  board.groupPositions["bundle:" + g] = { x: 1800, y: 40 };
  board.positions["bundle:" + g + "::" + n] = { x: 1816, y: 94 };
  board = addChapterMaterial(
    board,
    c,
    {
      id: item,
      kind: "note",
      label: "메모",
      order: 1,
      noteIds: [n],
      groupIds: [],
    },
    source,
  );
  const scene = buildScene(source, board);
  expect(
    scene.groups.find((group) => group.id === "bundle:" + g),
  ).toBeDefined();
  expect(board.positions["bundle:" + g + "::" + n]).toEqual({ x: 1816, y: 94 });
  expect(scene.nodes.filter((node) => node.noteId === n)).toHaveLength(2);
});
it("keeps the same original in different bundle chapters and moves just the chosen bundle", () => {
  const note = randomUUID(),
    a = randomUUID(),
    b = randomUUID(),
    c = randomUUID(),
    d = randomUUID();
  const source = {
    notes: [{ id: note, title: "공유", content: "같은 원문" }],
    books: [],
    topics: [],
    memberships: [],
    connections: [],
    bundles: [
      { id: a, title: "A", note_ids: [note] },
      { id: b, title: "B", note_ids: [note] },
    ],
  } as unknown as WhiteboardSnapshot;
  let board = addChapter(addChapter(emptyBoard(), c), d);
  for (const [chapter, id] of [
    [c, a],
    [d, b],
  ])
    board = addChapterMaterial(
      board,
      chapter,
      {
        id: randomUUID(),
        kind: "notes",
        label: id,
        order: 1,
        noteIds: [note],
        groupIds: ["bundle:" + id],
      },
      source,
    );
  expect(board.writing!.chapters.every((c) => c.items.length === 1)).toBe(true);
  const before = board.positions["bundle:" + b + "::" + note];
  board = moveChapter(board, c, -100, 200);
  expect(board.positions["bundle:" + b + "::" + note]).toEqual(before);
  expect(
    exportWritingBoard("글감", board, source, "txt").match(/같은 원문/g),
  ).toHaveLength(2);
});
