import {
  buildScene,
  emptyBoard,
  NOTE_WIDTH,
  NOTE_HEIGHT,
  type Board,
  type WhiteboardSnapshot,
} from "./whiteboard";
import type { z } from "zod";
import type { writingChapterSchema, writingMaterialSchema } from "./whiteboard";
import type { ResearchItem, ResearchPlacement } from "./research";
import { unpackOutline } from "./writing";
import { materialNoteIds, materialLabel } from "./thought-bundle-board";
import { boxNotes } from "./thought-boxes";
export type WritingChapter = z.infer<typeof writingChapterSchema>;
export type WritingMaterial = z.infer<typeof writingMaterialSchema>;
export function addChapter(board: Board, id: string): Board {
  const chapters = board.writing?.chapters ?? [];
  const order = Math.max(0, ...chapters.map((c) => c.order)) + 1;
  return {
    ...board,
    writing: {
      ...board.writing,
      chapters: [
        ...chapters,
        {
          id,
          order,
          title: `목차 ${order}`,
          text: "",
          x: chapters.length * 820 + 24,
          y: 24,
          width: 760,
          height: 320,
          items: [],
        },
      ],
    },
  };
}
export function placeChapterMaterials(
  board: Board,
  chapterId: string,
  source: WhiteboardSnapshot,
): Board {
  const chapter = board.writing?.chapters.find((c) => c.id === chapterId);
  if (!chapter) return board;
  const positions = { ...board.positions },
    groupPositions = { ...board.groupPositions };
  const scene = buildScene(source, {
    ...board,
    filter: emptyBoard().filter,
    hiddenNoteIds: [],
  });
  let y = chapter.y + 195;
  for (const item of [...chapter.items].sort(byOrder)) {
    const currentNoteIds = materialNoteIds(item, source);
    const groups = scene.groups.filter((g) => item.groupIds.includes(g.id));
    const grouped = new Set(
      groups.flatMap((g) => g.allNodes.map((n) => n.noteId)),
    );
    for (const group of groups) {
      const target = { x: chapter.x + 20, y };
      const dx = target.x - group.x,
        dy = target.y - group.y;
      groupPositions[group.id] = target;
      for (const n of group.allNodes.filter((n) =>
        currentNoteIds.includes(n.noteId),
      ))
        positions[n.id] = { x: n.x + dx, y: n.y + dy };
      y += group.height + 20;
    }
    const loose = currentNoteIds.filter((id) => !grouped.has(id));
    loose.forEach((id, index) => {
      const nodes = scene.nodes.filter(
        (n) =>
          n.noteId === id &&
          !n.groupId?.startsWith("bundle:") &&
          (!n.id.startsWith("chapter:") ||
            n.id.startsWith(`chapter:${chapter.id}:${item.id}::`)),
      );
      const p = {
        x: chapter.x + 20 + (index % 3) * (NOTE_WIDTH + 18),
        y: y + Math.floor(index / 3) * (NOTE_HEIGHT + 24),
      };
      if (nodes.length) for (const n of nodes) positions[n.id] = p;
      else positions["note::" + id] = p;
    });
    y += Math.ceil(loose.length / 3) * (NOTE_HEIGHT + 24) + 20;
  }
  return {
    ...board,
    positions,
    groupPositions,
    writing: {
      ...board.writing!,
      chapters: board.writing!.chapters.map((c) =>
        c.id === chapterId ? { ...c, height: Math.max(320, y - c.y + 30) } : c,
      ),
    },
  };
}
export function addChapterMaterial(
  board: Board,
  chapterId: string,
  item: WritingMaterial,
  source: WhiteboardSnapshot,
): Board {
  if (!board.writing?.chapters.some((c) => c.id === chapterId)) return board;
  const members = new Set(item.noteIds);
  const bundleIds = item.groupIds.filter((id) => id.startsWith("bundle:"));
  const chapters = board.writing.chapters.map((c) => ({
    ...c,
    items: c.items
      .filter(
        (i) =>
          !(
            bundleIds.length && i.groupIds.some((id) => bundleIds.includes(id))
          ),
      )
      .map((i) => ({
        ...i,
        noteIds:
          bundleIds.length || i.groupIds.some((id) => id.startsWith("bundle:"))
            ? i.noteIds
            : i.noteIds.filter((id) => !members.has(id)),
      }))
      .filter((i) => i.noteIds.length || i.kind === "topics"),
  }));
  const groups = board.groups
    .map((g) =>
      item.groupIds.includes(g.id)
        ? g
        : { ...g, noteIds: g.noteIds.filter((id) => !members.has(id)) },
    )
    .filter((g) => g.noteIds.length);
  const next = {
    ...board,
    groups,
    hiddenNoteIds: (board.hiddenNoteIds ?? []).filter((id) => !members.has(id)),
    writing: {
      ...board.writing,
      chapters: chapters.map((c) =>
        c.id === chapterId ? { ...c, items: [...c.items, item] } : c,
      ),
    },
  };
  return placeChapterMaterials(next, chapterId, source);
}
export function moveChapter(
  board: Board,
  id: string,
  dx: number,
  dy: number,
): Board {
  const c = board.writing?.chapters.find((c) => c.id === id);
  if (!c) return board;
  const ids = new Set(c.items.flatMap((i) => i.noteIds)),
    groups = new Set(c.items.flatMap((i) => i.groupIds));
  return {
    ...board,
    positions: Object.fromEntries(
      Object.entries(board.positions).map(([key, p]) => [
        key,
        groups.has(key.slice(0, key.lastIndexOf("::"))) ||
        key.startsWith(`chapter:${id}:`) ||
        (key.startsWith("note::") && ids.has(key.split("::").at(-1)!))
          ? { x: p.x + dx, y: p.y + dy }
          : p,
      ]),
    ),
    groupPositions: Object.fromEntries(
      Object.entries(board.groupPositions).map(([key, p]) => [
        key,
        groups.has(key) ? { x: p.x + dx, y: p.y + dy } : p,
      ]),
    ),
    writing: {
      ...board.writing!,
      chapters: board.writing!.chapters.map((v) =>
        v.id === id ? { ...v, x: v.x + dx, y: v.y + dy } : v,
      ),
    },
  };
}
export function chapterAt(board: Board, x: number, y: number) {
  return board.writing?.chapters.find(
    (c) => x >= c.x && x <= c.x + c.width && y >= c.y && y <= c.y + c.height,
  );
}
function byOrder(
  a: { order: number; id: string },
  b: { order: number; id: string },
) {
  return a.order - b.order || a.id.localeCompare(b.id);
}
export function exportWritingBoard(
  title: string,
  board: Board,
  source: WhiteboardSnapshot,
  format: "md" | "txt",
) {
  const notes = new Map(source.notes.map((n) => [n.id, n]));
  const books = new Map(source.books.map((b) => [b.id, b]));
  const heading = (level: number, text: string) =>
    format === "md" ? "#".repeat(level) + " " + text : text;
  return (
    [
      heading(1, title),
      ...(board.writing?.chapters ?? [])
        .slice()
        .sort(byOrder)
        .flatMap((chapter) => [
          heading(2, `${chapter.order}. ${chapter.title}`),
          chapter.text,
          ...boxNotes(chapter, source)
            .slice()
            .sort(byOrder)
            .flatMap((item) => [
              heading(
                3,
                `${chapter.order}.${item.order} ${materialLabel(item, source)}`,
              ),
              ...materialNoteIds(item, source).map((id) => {
                const note = notes.get(id);
                if (!note) return "[원본 메모를 찾을 수 없습니다.]";
                const book = note.bookId ? books.get(note.bookId) : null;
                return [
                  note.title,
                  note.content,
                  book
                    ? `${book.title}${note.page ? ` · p. ${note.page}` : ""}`
                    : "",
                ]
                  .filter(Boolean)
                  .join("\n\n");
              }),
            ]),
        ]),
    ]
      .filter(Boolean)
      .join("\n\n") + "\n"
  );
}
export function seedWritingBoard(
  project: { question: string },
  items: ResearchItem[],
  placements: ResearchPlacement[],
): Board {
  let board = emptyBoard();
  const outline = unpackOutline(project.question),
    sections = [
      ...new Set([
        ...outline.outline,
        ...placements.flatMap((p) => (p.section ? [p.section] : [])),
      ]),
    ];
  if (!sections.length && (items.length || outline.question.trim()))
    sections.push("글감");
  for (const [index, title] of sections.entries()) {
    const id = items[index]?.id ?? crypto.randomUUID();
    board = addChapter(board, id);
    board.writing!.chapters.at(-1)!.title = title;
    board.writing!.chapters.at(-1)!.text = index === 0 ? outline.question : "";
  }
  for (const item of items) {
    const p = placements.find((p) => p.id === item.id),
      chapter =
        board.writing?.chapters.find((c) => c.title === p?.section) ??
        board.writing?.chapters[0];
    if (chapter)
      chapter.items.push({
        id: item.id,
        order: p?.position || chapter.items.length + 1,
        kind: "note",
        label:
          item.snapshot.note.title || item.snapshot.note.content.slice(0, 40),
        noteIds: [item.snapshot.note.id ?? item.id],
        groupIds: [],
      });
  }
  return board;
}
