import { it, expect } from "vitest";
import {
  emptyBoard,
  buildScene,
  boardSchema,
  type WhiteboardSnapshot,
} from "../src/lib/whiteboard";
import {
  withWhiteboardNoteVisibility,
  whiteboardNoteVisible,
} from "../src/lib/whiteboard-visibility";
import { revealMemoGroup } from "../src/lib/whiteboard-workflows";
const a = "11111111-1111-4111-8111-111111111111",
  b = "22222222-2222-4222-8222-222222222222",
  c = "33333333-3333-4333-8333-333333333333";
it("hides only the board representation while preserving notes, links and placements, and shows it again", () => {
  const board = emptyBoard();
  board.positions["unclassified::" + a] = { x: 80, y: 90 };
  const source = {
    notes: [
      {
        id: a,
        title: "내 메모",
        content: "소중한 본문",
        bookId: null,
        kind: "thought",
        page: null,
        version: 1,
        createdAt: "2026-10-27",
        updatedAt: "2026-10-27",
      },
    ],
    books: [],
    topics: [],
    memberships: [],
    connections: [],
    topicLinks: [],
    board: { id: "board", data: board, version: 1 },
  } as WhiteboardSnapshot;
  expect(boardSchema.safeParse(board).success).toBe(true);
  const hidden = withWhiteboardNoteVisibility(board, a, false);
  expect(buildScene(source, hidden).nodes).toHaveLength(0);
  expect(source.notes[0].content).toBe("소중한 본문");
  expect(hidden.positions).toEqual(board.positions);
  expect(whiteboardNoteVisible(hidden, a)).toBe(false);
  const shown = withWhiteboardNoteVisibility(hidden, a, true);
  expect(buildScene(source, shown).nodes).toHaveLength(1);
  expect(shown.positions).toEqual(board.positions);
  expect(whiteboardNoteVisible(shown, a)).toBe(true);
});
it("reveals connected notes together without duplicates and preserves unrelated groups, hiding settings and links", () => {
  const board = emptyBoard(),
    old = "manual:" + b,
    keep = "manual:" + c,
    id = "manual:" + a;
  board.groups = [
    { id: old, title: "기존 묶음", noteIds: [a, b] },
    { id: keep, title: "남길 묶음", noteIds: [c] },
  ];
  board.links = [{ source: keep, target: "unclassified" }];
  const hidden = withWhiteboardNoteVisibility(board, a, false);
  const next = revealMemoGroup(hidden, [a, b], id);
  expect(next.groups.find((g) => g.id === id)?.noteIds).toEqual([a, b]);
  expect(
    next.groups.flatMap((g) => g.noteIds).filter((n) => n === a),
  ).toHaveLength(1);
  expect(next.groups.find((g) => g.id === keep)?.title).toBe("남길 묶음");
  expect(next.links).toEqual(board.links);
  expect(whiteboardNoteVisible(next, a)).toBe(false);
  expect(next.collapsed).not.toContain(id);
  expect(boardSchema.safeParse(next).success).toBe(true);
});
it("preserves extra notes already in the destination group and bounds new coordinates", () => {
  const board = emptyBoard(),
    id = "manual:" + a;
  board.groups = [{ id, title: "내가 정한 묶음", noteIds: [a, b, c] }];
  board.groupPositions[id] = { x: 49990, y: 49990 };
  const next = revealMemoGroup(board, [a, b], id);
  expect(next.groups.find((g) => g.id === id)?.noteIds).toContain(c);
  expect(next.groups.find((g) => g.id === id)?.title).toBe("내가 정한 묶음");
  expect(boardSchema.safeParse(next).success).toBe(true);
});
