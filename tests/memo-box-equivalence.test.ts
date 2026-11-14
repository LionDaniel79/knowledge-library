import { createHash } from "node:crypto";
import { it, expect, vi } from "vitest";
import { buildMemoBox, connectedMemoGroups } from "../src/lib/memo-box";
import type { WhiteboardSnapshot } from "../src/lib/whiteboard";

it("preserves the baseline output and order for 1,000 seeded connection, hierarchy and membership fixtures", () => {
  let state = 1989;
  const next = (n: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % n;
  };
  const hash = createHash("sha256");
  for (let run = 0; run < 1000; run++) {
    const notes = Array.from({ length: 1 + next(40) }, (_, i) => ({
      id: "n" + i,
      title: "메모" + i,
      content: "내용" + i,
      bookId: "b" + next(3),
    }));
    if (run % 17 === 0) notes.push({ ...notes[0], title: "사본 제목" });
    const connections = Array.from({ length: next(70) }, (_, i) => ({
      id: "c" + i,
      source_kind: next(9) === 0 ? "book" : "note",
      target_kind: "note",
      source_id: "n" + next(notes.length + 2),
      target_id: "n" + next(notes.length + 2),
      title: next(3) ? "제목" + i : "",
      reason: "이유" + i,
      status: next(6) ? "accepted" : "rejected",
      relation: "related",
      version: 1,
    }));
    const memoGroups = Array.from({ length: next(8) }, (_, i) => ({
      connectionIds: Array.from(
        { length: 1 + next(4) },
        () => "c" + next(connections.length + 1),
      ),
      title: i % 2 ? "전체 제목" : "",
      reason: "전체 이유",
      children: [],
    }));
    const source = {
      notes,
      connections,
      topics: [{ id: "t1", name: "주제" }],
      memberships: notes.flatMap((n) => [
        {
          sourceKind: "note",
          sourceId: n.id,
          topicId: "t1",
          status: next(4) ? "accepted" : "rejected",
        },
      ]),
      board: { id: "board", version: 1, data: { memoGroups } },
    } as unknown as WhiteboardSnapshot;
    const m = buildMemoBox(source);
    hash.update(
      JSON.stringify({
        groups: m.groups,
        edges: m.edges,
        connected: m.connected,
        noteTopics: [...m.noteTopics],
        connections: [...m.connections],
        members: [],
      }),
    );
  }
  // Captured from the unmodified b49224a implementation, including ordering,
  // shared notes, rejected/missing edges and explicit hierarchy overrides.
  expect(hash.digest("hex")).toBe(
    "82e43d8ec964ec0668d770bf4d0b7c0a1e5cbc3aa5c736154c99530b53bca007",
  );
});
it("keeps disjoint grouping within a linear filter-visit budget", () => {
  const notes = Array.from({ length: 2000 }, (_, i) => ({
    id: "n" + i,
    title: "메모" + i,
  }));
  const connections = Array.from({ length: 1000 }, (_, i) => ({
    id: "c" + i,
    source_kind: "note",
    target_kind: "note",
    source_id: "n" + i * 2,
    target_id: "n" + (i * 2 + 1),
    status: "accepted",
    title: "연결" + i,
  }));
  let visits = 0;
  const original = Array.prototype.filter;
  const spy = vi.spyOn(Array.prototype, "filter").mockImplementation(function (
    this: any[],
    callback: any,
    thisArg?: unknown,
  ) {
    return original.call(this, (value: any, index: number, array: any[]) => {
      visits++;
      return callback.call(thisArg, value, index, array);
    });
  });
  let groups = 0;
  try {
    groups = connectedMemoGroups({
      notes,
      connections,
    } as unknown as WhiteboardSnapshot).length;
  } finally {
    spy.mockRestore();
  }
  expect(groups).toBe(1000);
  expect(visits).toBeLessThanOrEqual(5000);
});
