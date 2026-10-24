import { describe, expect, it } from "vitest";
import {
  emptyBoard,
  type BoardConnection,
  type WhiteboardSnapshot,
} from "../src/lib/whiteboard";
import {
  buildConnectionLines,
  hitPolygon,
  nearestConnectionLine,
} from "../src/lib/whiteboard-lines";

const connection = (
  id: string,
  a: string,
  b: string,
  status = "accepted",
): BoardConnection => ({
  id,
  source_kind: "note",
  target_kind: "note",
  source_id: a,
  target_id: b,
  relation: "related",
  reason: "",
  status,
  version: 1,
});
const snapshot = (connections: BoardConnection[]): WhiteboardSnapshot => ({
  board: null,
  notes: [],
  books: [],
  topics: [],
  memberships: [],
  connections,
});
describe("whiteboard connection selection", () => {
  it("keeps every relationship ID when collapsed endpoints share a visible line", () => {
    const source = snapshot([
      connection("ab", "a", "b"),
      connection("ca", "c", "a"),
      connection("old", "a", "b", "rejected"),
    ]);
    const endpoint = (id: string) =>
      id === "a" ? { key: "g1", x: 0, y: 0 } : { key: "g2", x: 100, y: 0 };
    const lines = buildConnectionLines(
      source,
      emptyBoard(),
      endpoint,
      () => null,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].kind).toBe("note");
    if (lines[0].kind === "note")
      expect(lines[0].connections.map((c) => c.id)).toEqual(["ab", "ca"]);
    expect(source.connections[0].status).toBe("accepted");
  });
  it("omits hidden and internally collapsed relationships", () => {
    const lines = buildConnectionLines(
      snapshot([connection("ab", "a", "b"), connection("ac", "a", "c")]),
      emptyBoard(),
      (id) => (id === "c" ? null : { key: "same-group", x: 0, y: 0 }),
      () => null,
    );
    expect(lines).toHaveLength(0);
  });
  it("distinguishes a group link from real note relationships between the same groups", () => {
    const board = { ...emptyBoard(), links: [{ source: "g1", target: "g2" }] };
    const lines = buildConnectionLines(
      snapshot([connection("ab", "a", "b")]),
      board,
      (id) => ({ key: id, x: id === "a" ? 0 : 100, y: 50 }),
      (id) => ({ x: id === "g1" ? 0 : 100, y: 20 }),
    );
    expect(lines.map((l) => l.kind)).toEqual(["note", "group"]);
    if (lines[1].kind === "group")
      expect(lines[1].link).toEqual(board.links[0]);
    expect(board.links).toHaveLength(1);
  });
  it("retains a 44 CSS pixel target across zoom levels", () => {
    for (const zoom of [0.1, 0.9, 1.8]) {
      const points = hitPolygon(
        { a: { x: 0, y: 0 }, b: { x: 200, y: 0 } },
        zoom,
      );
      expect(
        (Math.max(...points.map((p) => p.y)) -
          Math.min(...points.map((p) => p.y))) *
          zoom,
      ).toBeCloseTo(44);
    }
    expect(
      hitPolygon({ a: { x: 0, y: 0 }, b: { x: 0, y: 0 } }, 0).every((p) =>
        Number.isFinite(p.x + p.y),
      ),
    ).toBe(true);
  });
  it("selects the nearest visible line when touch targets overlap", () => {
    const lines = buildConnectionLines(
      snapshot([connection("ab", "a", "b"), connection("cd", "c", "d")]),
      emptyBoard(),
      (id) => ({
        key: id,
        x: ["a", "c"].includes(id) ? 0 : 100,
        y: ["a", "b"].includes(id) ? 10 : 20,
      }),
      () => null,
    );
    expect(nearestConnectionLine(lines, { x: 50, y: 18 }, 22)?.id).toBe(
      lines[1].id,
    );
    expect(
      nearestConnectionLine(lines, { x: 200, y: 200 }, 22),
    ).toBeUndefined();
  });
});
