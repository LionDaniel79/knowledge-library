import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  emptyBoard,
  filterNotes,
  buildScene,
  dropTarget,
  mergeNotes,
  moveGroup,
  connectGroups,
  boardSchema,
  boardStamp,
  connectionForPair,
} from "../src/lib/whiteboard";
import type { WhiteboardSnapshot } from "../src/lib/whiteboard";
const n1 = randomUUID(),
  n2 = randomUUID(),
  n3 = randomUUID(),
  book = randomUUID(),
  topic = randomUUID();
const source: WhiteboardSnapshot = {
  board: null,
  notes: [
    {
      id: n1,
      bookId: book,
      title: "정서",
      content: "내용에만 있는 수용의 의미",
      tags: ["상담"],
      version: 1,
      kind: "note",
      page: null,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    },
    {
      id: n2,
      bookId: book,
      title: "다른 기록",
      content: "내 생각",
      tags: ["철학"],
      version: 1,
      kind: "thought",
      page: null,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    },
    {
      id: n3,
      bookId: null,
      title: "자유 메모",
      content: "본문",
      tags: [],
      version: 1,
      kind: "thought",
      page: null,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    },
  ],
  books: [
    {
      id: book,
      title: "상담 도서",
      author: "저자",
      publisher: "출판사",
      isbn: "",
      category: "100",
      tags: [],
      formats: ["paper"],
      shelf: "",
      totalPages: null,
      version: 1,
      createdAt: "2026-01-01",
    },
  ],
  topics: [{ id: topic, name: "정서 주제", version: 1 }],
  memberships: [
    { topicId: topic, sourceKind: "book", sourceId: book, status: "accepted" },
  ],
  connections: [],
};
describe("whiteboard", () => {
  it("recognizes a saved layout after JSONB object keys are reordered", () => {
    const data = emptyBoard();
    data.positions = { b: { x: 2, y: 3 }, a: { x: 4, y: 5 } };
    const row = {
      id: "00000000-0000-4000-8000-000000000001",
      version: 1,
      data,
    };
    expect(boardStamp(row)).toBe(
      boardStamp({
        ...row,
        data: { ...data, positions: { a: { y: 5, x: 4 }, b: { y: 3, x: 2 } } },
      }),
    );
    expect(boardStamp(row)).not.toBe(boardStamp({ ...row, version: 2 }));
  });
  it("places the next group row after a tall group without overlapping", () => {
    const other = randomUUID(),
      otherNote = randomUUID();
    const many = {
      ...source,
      topics: [...source.topics, { id: other, name: "다른 주제", version: 1 }],
      memberships: [
        ...source.memberships,
        {
          topicId: other,
          sourceKind: "note",
          sourceId: otherNote,
          status: "accepted",
        },
      ],
      notes: [
        ...Array.from({ length: 35 }, (_, i) => ({
          ...source.notes[0],
          id: randomUUID(),
          title: `메모${i}`,
        })),
        { ...source.notes[1], id: otherNote, bookId: null },
        source.notes[2],
      ],
    };
    const s = buildScene(many, emptyBoard()),
      a = s.groups.find((g) => g.id === `topic:${topic}`)!,
      b = s.groups.find((g) => g.id === "unclassified")!;
    expect(b.y).toBeGreaterThan(a.y + a.height);
  });
  it("searches full title/content with OR inside facets and AND between them", () => {
    const f = {
      ...emptyBoard().filter,
      q: "수용",
      tags: ["상담", "철학"],
      categories: ["100"],
      books: [book],
    };
    expect(filterNotes(source, f).map((n) => n.id)).toEqual([n1]);
    expect(filterNotes(source, { ...f, tags: ["없음"] })).toEqual([]);
  });
  it("uses only accepted topic assignments including the note's book", () => {
    expect(
      filterNotes(source, { ...emptyBoard().filter, topics: [topic] }).map(
        (n) => n.id,
      ),
    ).toEqual([n1, n2]);
    expect(
      filterNotes(
        {
          ...source,
          memberships: source.memberships.map((m) => ({
            ...m,
            status: "suggested",
          })),
        },
        { ...emptyBoard().filter, topics: [topic] },
      ),
    ).toEqual([]);
  });
  it("all topics groups notes and retains unclassified notes", () => {
    const scene = buildScene(source, emptyBoard());
    expect(
      scene.groups
        .find((g) => g.id === `topic:${topic}`)
        ?.nodes.map((n) => n.noteId),
    ).toEqual([n1, n2]);
    expect(
      scene.groups
        .find((g) => g.id === "unclassified")
        ?.nodes.map((n) => n.noteId),
    ).toEqual([n3]);
  });
  it("recognizes overlap and proximity but never a second instance of the same note", () => {
    const nodes = buildScene(source, {
      ...emptyBoard(),
      filter: { ...emptyBoard().filter, topics: [topic] },
    }).nodes;
    expect(
      dropTarget(nodes, nodes[0], { x: nodes[1].x, y: nodes[1].y })?.overlap,
    ).toBe(true);
    expect(
      dropTarget(nodes, nodes[0], { x: nodes[1].x - 245, y: nodes[1].y })
        ?.overlap,
    ).toBe(false);
    expect(
      dropTarget([nodes[0]], nodes[0], { x: nodes[0].x, y: nodes[0].y }),
    ).toBeNull();
  });
  it("merges a pile without duplicating originals and can keep its layout when filtered", () => {
    const board = emptyBoard(),
      scene = buildScene(source, board),
      groupId = `manual:${randomUUID()}`;
    const next = mergeNotes(board, scene.nodes[0], scene.nodes[1], groupId);
    expect(next.groups[0].noteIds.sort()).toEqual([n1, n2].sort());
    expect(next.collapsed).toContain(groupId);
    const filtered = buildScene(source, {
      ...next,
      filter: { ...next.filter, q: "수용" },
    });
    expect(filtered.nodes.map((n) => n.noteId)).toEqual([n1]);
    expect(next.groups[0].noteIds).toHaveLength(2);
  });
  it("moves all members together including members hidden by the filter", () => {
    const board = emptyBoard(),
      scene = buildScene(source, board),
      g = scene.groups[0];
    const moved = moveGroup(board, g, 100, 60);
    for (const node of g.allNodes)
      expect(moved.positions[node.id]).toEqual({
        x: node.x + 100,
        y: node.y + 60,
      });
  });
  it("group connections are undirected, unique and never a group self-link", () => {
    let b = connectGroups(emptyBoard(), `topic:${topic}`, "unclassified");
    b = connectGroups(b, "unclassified", `topic:${topic}`);
    expect(b.links).toHaveLength(1);
    expect(connectGroups(b, "unclassified", "unclassified").links).toHaveLength(
      1,
    );
  });
  it("finds an existing reverse note connection without changing its judgment", () => {
    const c = {
      id: randomUUID(),
      source_kind: "note",
      source_id: n2,
      target_kind: "note",
      target_id: n1,
      status: "accepted",
      relation: "challenges",
      reason: "내가 기록한 반론",
      version: 4,
    };
    expect(connectionForPair([c], n1, n2)).toEqual(c);
  });
  it("rejects non-finite coordinates and duplicate manual memberships", () => {
    expect(
      boardSchema.safeParse({
        ...emptyBoard(),
        positions: { a: { x: Infinity, y: 0 } },
      }).success,
    ).toBe(false);
    const group = {
      id: `manual:${randomUUID()}`,
      title: "묶음",
      noteIds: [n1, n1],
    };
    expect(
      boardSchema.safeParse({ ...emptyBoard(), groups: [group] }).success,
    ).toBe(false);
  });
});
