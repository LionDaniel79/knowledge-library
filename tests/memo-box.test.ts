import { describe, expect, it } from "vitest";
import { buildMemoBox } from "../src/lib/memo-box";
import { connectedMemoGroups } from "../src/lib/memo-box";
import { emptyBoard, type WhiteboardSnapshot } from "../src/lib/whiteboard";
it("lists one title group per accepted connected component, including cycles but excluding rejected and missing notes", () => {
  const s = {
    notes: [
      { id: "a", title: "첫 제목" },
      { id: "b", title: "둘째 제목" },
      { id: "c", title: "셋째 제목" },
      { id: "d", title: "독립 제목" },
    ],
    connections: [
      ...[
        ["a", "b"],
        ["b", "c"],
        ["c", "a"],
      ].map(([a, b], i) => ({
        id: String(i),
        source_kind: "note",
        target_kind: "note",
        source_id: a,
        target_id: b,
        status: "accepted",
      })),
      {
        id: "x",
        source_kind: "note",
        target_kind: "note",
        source_id: "c",
        target_id: "d",
        status: "rejected",
      },
      {
        id: "y",
        source_kind: "note",
        target_kind: "note",
        source_id: "c",
        target_id: "gone",
        status: "accepted",
      },
    ],
  } as WhiteboardSnapshot;
  const groups = connectedMemoGroups(s);
  expect(groups).toHaveLength(1);
  expect(groups[0].notes.map((n) => n.title)).toEqual([
    "첫 제목",
    "둘째 제목",
    "셋째 제목",
  ]);
  expect(groups[0].connections).toHaveLength(3);
});
describe("memo box", () => {
  it("uses accepted active note edges and respects a direct rejection of an inherited book topic", () => {
    const s = {
      board: { data: emptyBoard() },
      notes: [
        { id: "a", bookId: "book" },
        { id: "b", bookId: null },
        { id: "c", bookId: null },
      ],
      books: [],
      topics: [
        { id: "t", name: "T" },
        { id: "u", name: "U" },
      ],
      memberships: [
        {
          sourceKind: "book",
          sourceId: "book",
          topicId: "t",
          status: "accepted",
        },
        { sourceKind: "note", sourceId: "a", topicId: "t", status: "rejected" },
        { sourceKind: "note", sourceId: "a", topicId: "u", status: "accepted" },
        { sourceKind: "note", sourceId: "b", topicId: "t", status: "accepted" },
      ],
      connections: [
        {
          id: "ok",
          source_kind: "note",
          target_kind: "note",
          source_id: "a",
          target_id: "b",
          status: "accepted",
        },
        {
          id: "bad",
          source_kind: "note",
          target_kind: "note",
          source_id: "a",
          target_id: "c",
          status: "suggested",
        },
        {
          id: "trash",
          source_kind: "note",
          target_kind: "note",
          source_id: "b",
          target_id: "gone",
          status: "accepted",
        },
      ],
    } as unknown as WhiteboardSnapshot;
    const model = buildMemoBox(s);
    expect(model.connected.map((n) => n.id)).toEqual(["a", "b"]);
    expect(model.noteTopics.get("a")).toEqual(["u"]);
    expect(model.topicPairs).toHaveLength(1);
    expect(model.topicPairs[0].connectionIds).toEqual(["ok"]);
  });
  it("includes topic-group board links without treating manual groups as topics", () => {
    const board = emptyBoard();
    board.links = [
      { source: "topic:t", target: "topic:u" },
      { source: "manual:x", target: "topic:t" },
    ];
    const model = buildMemoBox({
      board: { data: board },
      notes: [],
      books: [],
      topics: [{ id: "t" }, { id: "u" }],
      memberships: [],
      connections: [],
    } as unknown as WhiteboardSnapshot);
    expect(model.topicPairs).toHaveLength(1);
    expect(model.topicPairs[0].board).toBe(true);
  });
});
