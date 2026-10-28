import { expect, it } from "vitest";
import {
  emptyBoard,
  boardSchema,
  buildScene,
  arrangeSearchResults,
} from "../src/lib/whiteboard";
import {
  addChapter,
  addChapterMaterial,
  exportWritingBoard,
  moveChapter,
  seedWritingBoard,
} from "../src/lib/writing-board";
const a = "11111111-1111-4111-8111-111111111111",
  b = "22222222-2222-4222-8222-222222222222";
const source = {
  notes: [
    { id: a, title: "첫 메모", content: "원문 전체\n둘째 줄", bookId: null },
    { id: b, title: "둘째 메모", content: "두번째 본문", bookId: null },
  ],
  books: [],
  topics: [],
  memberships: [],
  connections: [],
  board: null,
} as any;
it("keeps empty editable chapters and exact material order through a saved board roundtrip", () => {
  let board = addChapter(emptyBoard(), a);
  board = addChapter(board, b);
  board.writing!.chapters[0].order = 2;
  board.writing!.chapters[1].order = 1;
  board = addChapterMaterial(
    board,
    a,
    {
      id: a,
      order: 2,
      kind: "note",
      label: "첫 메모",
      noteIds: [a],
      groupIds: [],
    },
    source,
  );
  board = addChapterMaterial(
    board,
    a,
    {
      id: b,
      order: 1,
      kind: "notes",
      label: "두번째",
      noteIds: [b],
      groupIds: [],
    },
    source,
  );
  const restored = boardSchema.parse(JSON.parse(JSON.stringify(board)));
  expect(restored.writing!.chapters).toHaveLength(2);
  const txt = exportWritingBoard("작업", restored, source, "txt");
  expect(txt.indexOf("1. 목차 2")).toBeLessThan(txt.indexOf("2. 목차 1"));
  expect(txt.indexOf("두번째 본문")).toBeLessThan(
    txt.indexOf("원문 전체\n둘째 줄"),
  );
});
it("moving a chapter preserves positions of contained notes and keeps negative coordinates", () => {
  let board = addChapter(emptyBoard(), a);
  board = addChapterMaterial(
    board,
    a,
    {
      id: b,
      order: 1,
      kind: "note",
      label: "첫 메모",
      noteIds: [a],
      groupIds: [],
    },
    source,
  );
  const old = board.positions["note::" + a];
  board = moveChapter(board, a, -900, -500);
  expect(board.writing!.chapters[0].x).toBeLessThan(0);
  expect(board.positions["note::" + a]).toEqual({
    x: old.x - 900,
    y: old.y - 500,
  });
});
it("migrates legacy outline and snapshots without changing the original research assets", () => {
  const project = {
    title: "기존 글감",
    question: "질문\n\n## 목차\n1. 시작\n2. 마침",
  };
  const item = { id: b, snapshot: { note: source.notes[0] } } as any;
  const board = seedWritingBoard(project, [item], [
    { id: b, section: "마침", position: 1 },
  ] as any);
  expect(board.writing!.chapters.map((c) => c.title)).toEqual(["시작", "마침"]);
  expect(board.writing!.chapters[1].items[0].noteIds).toEqual([a]);
  expect(project.question).toContain("## 목차");
});
it("keeps chapter notes and their exact positions while replacing outside search results", () => {
  let board = addChapter(emptyBoard(), a);
  board = addChapterMaterial(
    board,
    a,
    {
      id: a,
      order: 1,
      kind: "note",
      label: "첫 메모",
      noteIds: [a],
      groupIds: [],
    },
    source,
  );
  const pinned = structuredClone(board.positions);
  board = arrangeSearchResults(source, {
    ...board,
    filter: { ...board.filter, q: "두번째" },
  });
  expect(buildScene(source, board).nodes.map((n) => n.noteId)).toContain(a);
  for (const [key, point] of Object.entries(pinned))
    if (key.endsWith(a)) expect(board.positions[key]).toEqual(point);
  board = arrangeSearchResults(source, {
    ...board,
    filter: { ...board.filter, q: "없는 검색어" },
  });
  expect(buildScene(source, board).nodes.map((n) => n.noteId)).toEqual([a]);
});
it("moving one note out of a chapter group cannot pull it back during later group layout", () => {
  let board = addChapter(emptyBoard(), a);
  board = addChapter(board, b);
  const groupId = "manual:" + a;
  board.groups = [{ id: groupId, title: "연결 메모", noteIds: [a, b] }];
  board = addChapterMaterial(
    board,
    a,
    {
      id: a,
      order: 1,
      kind: "notes",
      label: "묶음",
      noteIds: [a, b],
      groupIds: [groupId],
    },
    source,
  );
  board = addChapterMaterial(
    board,
    b,
    {
      id: b,
      order: 1,
      kind: "note",
      label: "옮길 메모",
      noteIds: [a],
      groupIds: [],
    },
    source,
  );
  expect(board.groups[0].noteIds).toEqual([b]);
  const position = buildScene(source, board).nodes.find((n) => n.noteId === a)!;
  board = addChapterMaterial(
    board,
    a,
    {
      id: b,
      order: 2,
      kind: "note",
      label: "기존",
      noteIds: [b],
      groupIds: [],
    },
    source,
  );
  const later = buildScene(source, board).nodes.find((n) => n.noteId === a)!;
  expect([later.x, later.y]).toEqual([position.x, position.y]);
});
