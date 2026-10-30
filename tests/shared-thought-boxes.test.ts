import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { emptyBoard, WHITEBOARD_ID, buildScene } from "../src/lib/whiteboard";
import { addThoughtBox, putBoxNotes } from "../src/lib/thought-boxes";
import {
  planThoughtBoxPromotion,
  projectSharedBoxes,
  referenceThoughtBox,
  arrangeThoughtBoard,
  sharedBoxSummaries,
} from "../src/lib/shared-thought-boxes";
const fixture = () => {
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
    connections: [],
    bundles: [],
  };
  let a = addThoughtBox(emptyBoard(), randomUUID(), "원본");
  a = putBoxNotes(a, a.writing!.chapters[0].id, ids.slice(0, 2), source);
  const original = a.writing!.chapters[0];
  const copy = {
    ...structuredClone(original),
    id: randomUUID(),
    sourceBox: { boardId: WHITEBOARD_ID, chapterId: original.id },
    x: 900,
  };
  const b = {
    ...emptyBoard(),
    writing: { chapters: [copy], excludedNoteIds: [] },
  };
  return { ids, source, a, b, original, other: randomUUID() };
};
it("promotes known copy chains once while preserving originals, coordinates and local numbering", () => {
  const f = fixture();
  f.b.writing.chapters[0].order = 7;
  f.b.writing.chapters[0].items[0].order = 8;
  const boards = [
    { id: WHITEBOARD_ID, data: f.a, version: 2 },
    { id: f.other, data: f.b, version: 4 },
  ];
  const before = structuredClone(boards);
  const plan = planThoughtBoxPromotion(boards, []);
  expect(plan.bundles).toHaveLength(1);
  expect(plan.bundles[0].id).toBe(f.original.id);
  expect(boards).toEqual(before);
  const changed = plan.boards.find((b: any) => b.id === f.other)!;
  expect(changed.data.writing!.chapters[0]).toMatchObject({
    bundleId: f.original.id,
    order: 7,
  });
  expect(changed.data.positions).toEqual(f.b.positions);
  expect(
    planThoughtBoxPromotion(plan.boards, plan.bundles).created,
  ).toHaveLength(0);
  expect(sharedBoxSummaries(plan.bundles)).toHaveLength(1);
});
it("repeated selection references the same original and shared edits retain writing-only order", () => {
  const f = fixture(),
    plan = planThoughtBoxPromotion(
      [{ id: WHITEBOARD_ID, data: f.a, version: 1 }],
      [],
    );
  const bundle = plan.bundles[0];
  let board = referenceThoughtBox(emptyBoard(), bundle, f.source);
  board.writing!.excludedNoteIds = [];
  board.writing!.chapters[0].order = 4;
  board.writing!.chapters[0].items[0].order = 9;
  const again = referenceThoughtBox(board, bundle, f.source);
  expect(again).toBe(board);
  const source = {
    ...f.source,
    bundles: [
      {
        ...bundle,
        title: "새 제목",
        description: "공유 내용",
        note_ids: f.ids,
      },
    ],
  };
  const view = projectSharedBoxes(board, source);
  expect(view.writing!.chapters).toHaveLength(1);
  expect(view.writing!.chapters[0]).toMatchObject({
    title: "새 제목",
    text: "공유 내용",
    order: 4,
  });
  expect(
    view.writing!.chapters[0].items.find((i: any) => i.noteIds[0] === f.ids[0])!
      .order,
  ).toBe(9);
  expect(
    buildScene(source, view).nodes.filter((n) => n.chapterId),
  ).toHaveLength(3);
});
it("writing excludes loose memos independently of ordinary whiteboard visibility and arrange fits boxes", () => {
  const f = fixture();
  f.a.hiddenNoteIds = [f.ids[0]];
  f.a.writing!.excludedNoteIds = [f.ids[2]];
  const first = f.a.writing!.chapters[0];
  first.width = 2300;
  first.height = 10000;
  const view = arrangeThoughtBoard(f.a, f.source);
  expect(view.writing!.chapters[0].width).toBeLessThan(1000);
  expect(view.writing!.chapters[0].height).toBeLessThan(1000);
  const nodes = buildScene(f.source, view).nodes;
  expect(nodes.some((n) => n.noteId === f.ids[0])).toBe(true);
  expect(nodes.some((n) => n.noteId === f.ids[2])).toBe(false);
  expect(f.a.writing!.chapters[0].height).toBe(10000);
});
it("resolves a legacy ancestry cycle to one original even when a smaller-id tail enters it", () => {
  const f = fixture();
  const boardIds = [1, 2, 3].map(
    (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  );
  const chapters = [0, 1, 2].map(() => structuredClone(f.original));
  chapters.forEach((c) => {
    c.id = randomUUID();
  });
  chapters[0].sourceBox = { boardId: boardIds[1], chapterId: chapters[1].id };
  chapters[1].sourceBox = { boardId: boardIds[2], chapterId: chapters[2].id };
  chapters[2].sourceBox = { boardId: boardIds[1], chapterId: chapters[1].id };
  const plan = planThoughtBoxPromotion(
    boardIds.map((id, i) => ({
      id,
      version: 1,
      data: { ...emptyBoard(), writing: { chapters: [chapters[i]] } },
    })),
    [],
  );
  expect(plan.created).toHaveLength(1);
  expect(
    new Set(plan.boards.map((b) => b.data.writing!.chapters[0].bundleId)).size,
  ).toBe(1);
});
it("preserves late legacy additions until an explicit version-bound merge without duplicating the original", () => {
  const f = fixture(),
    canonical = {
      id: f.original.id,
      title: "최근 원본",
      description: "최근 내용",
      note_ids: [f.ids[0]],
      version: 4,
      archived_at: null,
    };
  const boards = [{ id: f.other, data: f.b, version: 3 }];
  const planned = planThoughtBoxPromotion(boards, [canonical]);
  expect(planned.conflicts).toHaveLength(1);
  expect(planned.boards[0].data.writing!.chapters[0].bundleId).toBeUndefined();
  expect(planned.bundles[0].note_ids).toEqual([f.ids[0]]);
  const pendingOriginal = {
    ...planned.boards[0].data,
    writing: {
      ...planned.boards[0].data.writing!,
      chapters: planned.boards[0].data.writing!.chapters.map((c) => ({
        ...c,
        id: canonical.id,
      })),
    },
  };
  expect(referenceThoughtBox(pendingOriginal, canonical, f.source)).toBe(
    pendingOriginal,
  );
  const accepted = planThoughtBoxPromotion(
    boards,
    [canonical],
    planned.legacyToken,
  );
  expect(accepted.created).toHaveLength(0);
  expect(accepted.updated).toHaveLength(1);
  expect(accepted.bundles[0]).toMatchObject({
    title: "최근 원본",
    description: "최근 내용",
    note_ids: f.ids.slice(0, 2),
    version: 5,
  });
  expect(accepted.boards[0].data.writing!.chapters[0].bundleId).toBe(
    canonical.id,
  );
  const stale = planThoughtBoxPromotion(
    boards,
    [{ ...canonical, version: 5 }],
    planned.legacyToken,
  );
  expect(stale.updated).toHaveLength(0);
  expect(stale.boards[0].data.writing!.chapters[0].bundleId).toBeUndefined();
});
