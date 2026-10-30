import { describe, it, expect } from "vitest";
import { mergeWritingBoards } from "../src/lib/merge-writing-boards";
import { emptyBoard, type Board } from "../src/lib/whiteboard";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function board(n: number, bundleId?: string): Board {
  const data = emptyBoard();
  data.writing = {
    chapters: [
      {
        id: id(n),
        order: 8,
        title: `상자 ${n}`,
        text: `본문 ${n}`,
        x: -40,
        y: 900,
        width: 760,
        height: 360,
        items: [
          {
            id: id(n + 100),
            order: 7,
            kind: "note",
            label: "메모",
            noteIds: [id(n + 200)],
            groupIds: [],
          },
        ],
        ...(bundleId ? { bundleId } : {}),
      },
    ],
  };
  data.positions[`chapter:${id(n)}:${id(n + 100)}::${id(n + 200)}`] = {
    x: -20,
    y: 1060,
  };
  return data;
}
describe("mergeWritingBoards", () => {
  it("creates non-overlapping ordered references and preserves source chapters and memo order", () => {
    const a = board(1),
      b = board(2);
    const before = JSON.stringify([a, b]);
    const result = mergeWritingBoards([
      { id: id(10), data: a },
      { id: id(20), data: b },
    ]);
    expect(JSON.stringify([a, b])).toBe(before);
    const chapters = result.writing!.chapters;
    expect(chapters.map((c) => c.order)).toEqual([1, 2]);
    expect(chapters.map((c) => c.items[0].order)).toEqual([7, 7]);
    expect(chapters.map((c) => c.sourceBox)).toEqual([
      { boardId: id(10), chapterId: id(1) },
      { boardId: id(20), chapterId: id(2) },
    ]);
    expect(chapters[1].x).toBeGreaterThanOrEqual(
      chapters[0].x + chapters[0].width,
    );
    expect(
      result.positions[`chapter:${chapters[0].id}:${id(101)}::${id(201)}`],
    ).toEqual({ x: chapters[0].x + 20, y: chapters[0].y + 160 });
  });
  it("deduplicates the same shared box original without creating a new original", () => {
    const a = board(1, id(90)),
      b = board(2, id(90));
    const result = mergeWritingBoards([
      { id: id(10), data: a },
      { id: id(20), data: b },
    ]);
    expect(result.writing!.chapters).toHaveLength(1);
    expect(result.writing!.chapters[0]).toMatchObject({
      bundleId: id(90),
      text: "본문 1",
    });
  });
  it("keeps an existing legacy sourceBox identity and unboxed placements", () => {
    const a = board(1),
      b = board(2);
    a.writing!.chapters[0].sourceBox = { boardId: id(60), chapterId: id(61) };
    b.writing!.chapters[0].sourceBox = { boardId: id(60), chapterId: id(61) };
    a.positions[`note::${id(70)}`] = { x: 500, y: -90 };
    const result = mergeWritingBoards([
      { id: id(10), data: a },
      { id: id(20), data: b },
    ]);
    expect(result.writing!.chapters).toHaveLength(1);
    expect(result.writing!.chapters[0].sourceBox).toEqual({
      boardId: id(60),
      chapterId: id(61),
    });
    expect(result.positions[`note::${id(70)}`]).toBeDefined();
  });
});
