import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  emptyBoard,
  buildScene,
  type WhiteboardSnapshot,
} from "../src/lib/whiteboard";
import {
  addThoughtBox,
  putBoxNotes,
  thoughtView,
  flattenBox,
  boxNodeId,
} from "../src/lib/thought-boxes";
import { exportWritingBoard } from "../src/lib/writing-board";
const make = () => {
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  const source = {
    notes: ids.map((id, i) => ({
      id,
      title: `메모${i}`,
      content: `원문${i}`,
      bookId: null,
    })),
    books: [],
    topics: [],
    memberships: [],
    connections: [
      {
        id: randomUUID(),
        source_kind: "note",
        target_kind: "note",
        source_id: ids[0],
        target_id: ids[1],
        status: "accepted",
        relation: "related",
        reason: "",
        version: 1,
      },
    ],
    bundles: [],
    bundleLinks: [],
    board: null,
  } as unknown as WhiteboardSnapshot;
  return { ids, source };
};
it("keeps one original memo in multiple boxes with separate positions and per-memo export order", () => {
  const { ids, source } = make(),
    a = randomUUID(),
    b = randomUUID();
  let board = addThoughtBox(addThoughtBox(emptyBoard(), a), b);
  board = putBoxNotes(board, a, ids.slice(0, 2), source);
  board = putBoxNotes(board, b, [ids[0]], source);
  const first = board.writing!.chapters[0],
    second = board.writing!.chapters[1];
  expect(first.items).toHaveLength(2);
  expect(second.items).toHaveLength(1);
  expect(
    buildScene(source, board).nodes.filter((n) => n.noteId === ids[0]),
  ).toHaveLength(2);
  expect(board.positions[boxNodeId(a, first.items[0].id, ids[0])]).not.toEqual(
    board.positions[boxNodeId(b, second.items[0].id, ids[0])],
  );
  first.items[0].order = 2;
  first.items[1].order = 1;
  const text = exportWritingBoard("글", board, source, "md");
  expect(text.indexOf("원문1")).toBeLessThan(text.indexOf("원문0"));
});
it("adds selected connection views outside existing boxes without losing or moving their notes", () => {
  const { ids, source } = make(),
    box = randomUUID();
  let board = putBoxNotes(
    addThoughtBox(emptyBoard(), box),
    box,
    [ids[0]],
    source,
  );
  const before = structuredClone(board),
    view = thoughtView(source, board, [source.connections[0].id]);
  expect(view.board.writing).toEqual(before.writing);
  expect(board).toEqual(before);
  const scene = buildScene(view.source, view.board),
    old = before.writing!.chapters[0];
  expect(scene.nodes.some((n) => n.noteId === ids[0])).toBe(true);
  expect(scene.nodes.some((n) => n.noteId === ids[1])).toBe(true);
  const extra = scene.nodes.find((n) => n.noteId === ids[1])!;
  expect(extra.x).toBeGreaterThanOrEqual(old.x + old.width);
  const original = scene.nodes.find((n) => n.noteId === ids[0])!;
  expect({ x: original.x, y: original.y }).toEqual(
    before.positions[original.id],
  );
});
it("preserves legacy grouped material order when flattening into numbered individual memos", () => {
  const { ids, source } = make();
  const id = randomUUID();
  const board = addThoughtBox(emptyBoard(), id);
  const chapter = board.writing!.chapters[0];
  chapter.items = [
    {
      id: randomUUID(),
      order: 1,
      kind: "notes",
      label: "묶음",
      noteIds: ids.slice(0, 2),
      groupIds: [],
    },
    {
      id: randomUUID(),
      order: 2,
      kind: "note",
      label: "마지막",
      noteIds: [ids[2]],
      groupIds: [],
    },
  ];
  const flat = flattenBox(chapter, source);
  expect(flat.items.map((i) => i.order)).toEqual([1, 2, 3]);
  const output = exportWritingBoard("글", board, source, "txt");
  expect(output.indexOf("원문0")).toBeLessThan(output.indexOf("원문1"));
  expect(output.indexOf("원문1")).toBeLessThan(output.indexOf("원문2"));
});
