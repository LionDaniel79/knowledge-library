import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  emptyBoard,
  buildScene,
  type WhiteboardSnapshot,
} from "../src/lib/whiteboard";
import { referenceThoughtBox } from "../src/lib/shared-thought-boxes";
import { boardDisplaySelection } from "../src/lib/whiteboard-display";
import { arrangePlainMemos } from "../src/lib/whiteboard-display";
const make = () => {
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  const source: any = {
    notes: ids.map((id, i) => ({
      id,
      title: "메모" + i,
      content: "본문",
      tags: [],
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
    bundles: [
      {
        id: randomUUID(),
        title: "생각 원본",
        description: "내용",
        note_ids: ids.slice(0, 2),
        version: 1,
        archived_at: null,
      },
    ],
    board: null,
  };
  let board = referenceThoughtBox(emptyBoard(), source.bundles[0], source);
  const manual = "manual:" + randomUUID();
  board.groups = [
    { id: manual, title: "연결된 메모", noteIds: [ids[0], ids[1]] },
  ];
  board.positions[manual + "::" + ids[0]] = { x: -100, y: 200 };
  return { ids, source: source as WhiteboardSnapshot, board, manual };
};
it("ordinary board hides saved and legacy thought boxes until explicitly selected, without changing the saved board", () => {
  const f = make(),
    a = f.source.bundles![0],
    b = { ...a, id: randomUUID(), note_ids: [f.ids[2]] };
  f.source.bundles!.push(b);
  f.board.groupPositions["bundle:" + b.id] = { x: 900, y: 0 };
  const saved = structuredClone(f.board);
  const initial = boardDisplaySelection(
    f.source,
    f.board,
    { connections: null, boxes: {}, plain: false },
    false,
  );
  expect(initial.board.writing!.chapters).toHaveLength(0);
  expect(
    buildScene(initial.source, initial.board).groups.map((g) => g.id),
  ).not.toContain("bundle:" + b.id);
  const chosen = boardDisplaySelection(
    f.source,
    f.board,
    { connections: [], boxes: { [a.id]: true }, plain: false },
    false,
  );
  expect(chosen.board.writing!.chapters.map((c) => c.bundleId)).toEqual([a.id]);
  expect(f.board).toEqual(saved);
});
it("selection is a pure display and returning to the ordinary board shows individual memos without removing originals", () => {
  const f = make(),
    before = structuredClone(f.board),
    bundle = f.source.bundles![0];
  const selected = boardDisplaySelection(
    f.source,
    f.board,
    { connections: [], boxes: { [bundle.id]: true }, plain: false },
    false,
  );
  expect(selected.board.writing!.chapters).toHaveLength(1);
  const all = boardDisplaySelection(
      f.source,
      f.board,
      { connections: null, boxes: {}, plain: true },
      false,
    ),
    scene = buildScene(all.source, all.board, { plain: all.plain });
  expect(all.board.writing!.chapters).toHaveLength(0);
  expect(scene.groups).toHaveLength(0);
  expect(scene.nodes).toHaveLength(3);
  expect(scene.nodes.every((n) => !n.chapterId && !n.groupId)).toBe(true);
  expect(f.board).toEqual(before);
});
it("a displayed original can be toggled off while writing project contents and saved coordinates remain unchanged", () => {
  const f = make(),
    bundle = f.source.bundles![0],
    before = structuredClone(f.board);
  f.board.writing!.excludedNoteIds = [];
  const yes = boardDisplaySelection(
    f.source,
    f.board,
    { connections: [], boxes: { [bundle.id]: true }, plain: false },
    true,
  );
  const no = boardDisplaySelection(
    f.source,
    f.board,
    { connections: [], boxes: { [bundle.id]: false }, plain: false },
    true,
  );
  expect(yes.board.writing!.chapters).toHaveLength(1);
  expect(no.board.writing!.chapters).toHaveLength(0);
  expect(f.board.positions).toEqual(before.positions);
  expect(f.source.bundles).toHaveLength(1);
});
it("obsolete generated connection frames disappear when accepted edges are removed, preserving notes and custom arrangements", () => {
  const f = make();
  f.source.connections[0].status = "rejected";
  f.board.writing = { chapters: [] };
  const result = boardDisplaySelection(
    f.source,
    f.board,
    { connections: null, boxes: {}, plain: false },
    false,
  );
  expect(result.board.groups).toHaveLength(0);
  expect(buildScene(result.source, result.board).nodes).toHaveLength(3);
  expect(result.board.positions["note::" + f.ids[0]]).toEqual({
    x: -100,
    y: 200,
  });
  expect(f.board.groups).toHaveLength(1);
});
it("removes only disconnected members from an old generated frame and preserves the surviving connection", () => {
  const f = make();
  f.board.writing = { chapters: [] };
  f.board.groups[0].noteIds = [...f.ids];
  f.board.positions[f.manual + "::" + f.ids[2]] = { x: 900, y: 200 };
  const view = boardDisplaySelection(
    f.source,
    f.board,
    { connections: null, boxes: {}, plain: false },
    false,
  );
  expect(view.board.groups[0].noteIds).toEqual(f.ids.slice(0, 2));
  expect(view.board.positions["note::" + f.ids[2]]).toEqual({ x: 900, y: 200 });
  expect(
    buildScene(view.source, view.board)
      .nodes.map((n) => n.noteId)
      .sort(),
  ).toEqual([...f.ids].sort());
});
it("arranges the plain view without moving hidden originals or recreating boxes", () => {
  const f = make(),
    old = structuredClone(f.board);
  const view = boardDisplaySelection(
    f.source,
    f.board,
    { connections: null, boxes: {}, plain: true },
    false,
  );
  const next = arrangePlainMemos(view.source, view.board, f.board);
  expect(next.writing).toEqual(old.writing);
  expect(next.positions["note::" + f.ids[0]]).toEqual({ x: 24, y: 24 });
  expect(f.board).toEqual(old);
});
it("uses saved chapter orders when assigning a temporary external box number", () => {
  const f = make();
  f.board.writing!.chapters[0].order = 7;
  const bundle = {
    ...f.source.bundles![0],
    id: randomUUID(),
    title: "다른 상자",
  };
  f.source.bundles!.push(bundle);
  const view = boardDisplaySelection(
    f.source,
    f.board,
    {
      connections: [],
      boxes: { [f.source.bundles![0].id]: false, [bundle.id]: true },
      plain: false,
    },
    true,
  );
  expect(view.board.writing!.chapters).toHaveLength(1);
  expect(view.board.writing!.chapters[0].order).toBe(8);
});
it("retains accepted legacy bundle links while keeping plain display free of bundle frames", () => {
  const f = make(),
    a = f.source.bundles![0],
    b = { ...a, id: randomUUID(), note_ids: [f.ids[2]] };
  f.source.bundles!.push(b);
  f.source.bundleLinks = [
    {
      id: randomUUID(),
      source_id: a.id,
      target_id: b.id,
      status: "accepted",
      relation: "related",
      reason: "원래 연결",
      version: 1,
    },
  ];
  f.board.writing = { chapters: [] };
  f.board.groupPositions["bundle:" + a.id] = { x: 0, y: 0 };
  f.board.groupPositions["bundle:" + b.id] = { x: 900, y: 0 };
  const view = boardDisplaySelection(
    f.source,
    f.board,
    { connections: null, boxes: { [a.id]: true, [b.id]: true }, plain: false },
    false,
  );
  expect(view.board.links).toContainEqual({
    source: "bundle:" + a.id,
    target: "bundle:" + b.id,
  });
});
