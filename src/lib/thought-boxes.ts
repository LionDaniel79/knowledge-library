import type { Board, WhiteboardSnapshot } from "./whiteboard";
import type { WritingChapter, WritingMaterial } from "./writing-board";
import { noteContextId } from "./note-context";
import { materialNoteIds, materialLabel } from "./thought-bundle-board";
import { connectedMemoGroups } from "./memo-box";
export const BOX_NOTE_TOP = 152,
  BOX_NOTE_DX = 238,
  BOX_NOTE_DY = 194;
const DEFAULT_BOARD = "00000000-0000-4000-8000-000000000001";
export interface ThoughtBoxSummary {
  id: string;
  boardId: string;
  chapterId: string;
  boardTitle: string;
  title: string;
  order: number;
  noteCount: number;
  boardVersion: number;
}
export const boxKey = (boardId: string, chapterId: string) =>
  boardId + ":" + chapterId;
export const boxNodeId = (chapterId: string, itemId: string, noteId: string) =>
  `chapter:${chapterId}:${itemId}::${noteId}`;
export function listThoughtBoxes(
  boards: { id: string; data: Board; version: number }[],
  projects: { id: string; title: string }[],
): ThoughtBoxSummary[] {
  const titles = new Map(projects.map((p) => [p.id, p.title]));
  return boards
    .filter((b) => b.id === DEFAULT_BOARD || titles.has(b.id))
    .flatMap((b) =>
      (b.data.writing?.chapters ?? []).map((c) => ({
        id: boxKey(b.id, c.id),
        boardId: b.id,
        chapterId: c.id,
        boardTitle: titles.get(b.id) ?? "화이트보드",
        title: c.title,
        order: c.order,
        noteCount: new Set(c.items.flatMap((i) => i.noteIds)).size,
        boardVersion: b.version,
      })),
    )
    .sort(
      (a, b) =>
        a.boardTitle.localeCompare(b.boardTitle, "ko") ||
        a.order - b.order ||
        a.id.localeCompare(b.id),
    );
}
export function flattenBox(
  chapter: WritingChapter,
  source: WhiteboardSnapshot,
): WritingChapter {
  const seen = new Set<string>(),
    items: WritingMaterial[] = [];
  const expanded = chapter.items.some(
    (item) => materialNoteIds(item, source).length > 1,
  );
  let lastOrder = 0;
  for (const item of [...chapter.items].sort(
    (a, b) => a.order - b.order || a.id.localeCompare(b.id),
  )) {
    const ids = materialNoteIds(item, source);
    for (const id of ids)
      if (!seen.has(id)) {
        seen.add(id);
        const note = source.notes.find((n) => n.id === id);
        items.push({
          id:
            ids.length === 1
              ? item.id
              : noteContextId(chapter.id, item.id + ":" + id, 0),
          order: expanded
            ? (lastOrder = Math.max(item.order, lastOrder + 1))
            : item.order,
          kind: "note",
          label: item.groupIds.some((id) => id.startsWith("bundle:"))
            ? `${materialLabel(item, source)} · ${note?.title || note?.content.slice(0, 40) || "메모"}`.slice(
                0,
                300,
              )
            : note?.title || note?.content.slice(0, 40) || item.label,
          noteIds: [id],
          groupIds: [],
        });
      }
  }
  return { ...chapter, items };
}
export function boxNotes(chapter: WritingChapter, source: WhiteboardSnapshot) {
  return flattenBox(chapter, source).items;
}
export function freeBoxOrigin(board: Board) {
  const chapters = board.writing?.chapters ?? [];
  return {
    x: chapters.length
      ? Math.max(...chapters.map((c) => c.x + c.width)) + 48
      : 24,
    y: chapters.length ? Math.min(...chapters.map((c) => c.y)) : 24,
  };
}
export function addThoughtBox(board: Board, id: string, title?: string): Board {
  const chapters = board.writing?.chapters ?? [],
    order = Math.max(0, ...chapters.map((c) => c.order)) + 1;
  return {
    ...board,
    writing: {
      ...board.writing,
      chapters: [
        ...chapters,
        {
          id,
          order,
          title: title ?? `생각 묶음 ${order}`,
          text: "",
          ...freeBoxOrigin(board),
          width: 760,
          height: 360,
          items: [],
        },
      ],
    },
  };
}
export function arrangeBox(
  board: Board,
  chapterId: string,
  source: WhiteboardSnapshot,
  preserve = true,
): Board {
  const c = board.writing?.chapters.find((c) => c.id === chapterId);
  if (!c) return board;
  const flat = flattenBox(c, source),
    positions = { ...board.positions };
  let maxBottom = c.y + BOX_NOTE_TOP;
  for (const [index, item] of [...flat.items]
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .entries()) {
    const id = item.noteIds[0],
      key = boxNodeId(c.id, item.id, id);
    const old =
      positions[key] ??
      Object.entries(positions).find(
        ([k, p]) =>
          k.endsWith("::" + id) &&
          p.x >= c.x &&
          p.x < c.x + c.width &&
          p.y >= c.y + 120 &&
          p.y < c.y + c.height,
      )?.[1];
    const p =
      preserve && old
        ? old
        : {
            x: c.x + 20 + (index % 3) * BOX_NOTE_DX,
            y: c.y + BOX_NOTE_TOP + Math.floor(index / 3) * BOX_NOTE_DY,
          };
    positions[key] = p;
    maxBottom = Math.max(maxBottom, p.y + 166 + 24);
  }
  return {
    ...board,
    positions,
    writing: {
      ...board.writing!,
      chapters: board.writing!.chapters.map((v) =>
        v.id === c.id
          ? { ...flat, height: Math.max(c.height, maxBottom - c.y) }
          : v,
      ),
    },
  };
}
export function putBoxNotes(
  board: Board,
  chapterId: string,
  noteIds: string[],
  source: WhiteboardSnapshot,
): Board {
  const c = board.writing?.chapters.find((c) => c.id === chapterId);
  if (!c) return board;
  const next = flattenBox(c, source),
    existing = new Set(next.items.flatMap((i) => i.noteIds));
  for (const id of noteIds)
    if (!existing.has(id)) {
      const note = source.notes.find((n) => n.id === id);
      if (!note) continue;
      existing.add(id);
      next.items.push({
        id: noteContextId(c.id, id, 0),
        order: Math.max(0, ...next.items.map((i) => i.order)) + 1,
        kind: "note",
        label: note.title || note.content.slice(0, 40),
        noteIds: [id],
        groupIds: [],
      });
    }
  const removed = new Set(noteIds);
  return arrangeBox(
    {
      ...board,
      groups: board.groups
        .map((g) => ({
          ...g,
          noteIds: g.noteIds.filter((id) => !removed.has(id)),
        }))
        .filter((g) => g.noteIds.length),
      hiddenNoteIds: (board.hiddenNoteIds ?? []).filter(
        (id) => !removed.has(id),
      ),
      writing: {
        ...board.writing!,
        chapters: board.writing!.chapters.map((v) =>
          v.id === c.id ? next : v,
        ),
      },
    },
    c.id,
    source,
  );
}
export function copyThoughtBox(
  board: Board,
  sourceBoardId: string,
  chapter: WritingChapter,
  source: WhiteboardSnapshot,
  id = crypto.randomUUID(),
): Board {
  const old = board.writing?.chapters.find(
    (c) =>
      c.sourceBox?.boardId === sourceBoardId &&
      c.sourceBox?.chapterId === chapter.id,
  );
  if (old) return board;
  let next = addThoughtBox(board, id, chapter.title);
  const flat = flattenBox(chapter, source),
    copy = next.writing!.chapters.at(-1)!;
  copy.width = chapter.width;
  copy.height = chapter.height;
  copy.text = chapter.text;
  copy.sourceBox = { boardId: sourceBoardId, chapterId: chapter.id };
  copy.items = flat.items.map((item) => ({
    ...item,
    id: noteContextId(id, item.noteIds[0], 0),
  }));
  const positions = { ...next.positions };
  const original =
    source.board?.id === sourceBoardId ? source.board.data.positions : {};
  copy.items.forEach((item, index) => {
    const prior = flat.items[index],
      noteId = item.noteIds[0];
    const saved =
      original[boxNodeId(chapter.id, prior.id, noteId)] ??
      Object.entries(original).find(
        ([key, p]) =>
          key.endsWith("::" + noteId) &&
          p.x >= chapter.x &&
          p.x < chapter.x + chapter.width &&
          p.y >= chapter.y &&
          p.y < chapter.y + chapter.height,
      )?.[1];
    if (saved)
      positions[boxNodeId(copy.id, item.id, noteId)] = {
        x: copy.x + saved.x - chapter.x,
        y: copy.y + saved.y - chapter.y,
      };
  });
  next = arrangeBox({ ...next, positions }, id, source);
  return next;
}
export function thoughtView(
  source: WhiteboardSnapshot,
  board: Board,
  selected: "all" | readonly string[],
) {
  const edges =
    selected === "all"
      ? source.connections
      : source.connections.filter((c) => selected.includes(c.id));
  const groups = connectedMemoGroups({ ...source, connections: edges });
  const pinned = new Set(
    (board.writing?.chapters ?? []).flatMap((c) =>
      boxNotes(c, source).flatMap((i) => i.noteIds),
    ),
  );
  const wanted = new Set([
    ...pinned,
    ...groups.flatMap((g) => g.notes.map((n) => n.id)),
  ]);
  let y = 24;
  const x = Math.max(
    24,
    ...(board.writing?.chapters ?? []).map((c) => c.x + c.width + 48),
  );
  const positions = { ...board.positions },
    groupPositions = { ...board.groupPositions };
  const shown = groups.flatMap((g) => {
    const ids = g.notes.filter((n) => !pinned.has(n.id)).map((n) => n.id);
    if (!ids.length) return [];
    const id = "manual:" + g.id,
      origin = groupPositions[id];
    const p = origin && origin.x >= x ? origin : { x, y };
    groupPositions[id] = p;
    ids.forEach((note, j) => {
      const key = id + "::" + note;
      const old = positions[key];
      positions[key] =
        old && old.x >= x
          ? old
          : {
              x: p.x + 16 + (j % 3) * 236,
              y: p.y + 54 + Math.floor(j / 3) * 182,
            };
    });
    y += Math.max(240, Math.ceil(ids.length / 3) * 182 + 60) + 40;
    return [{ id, title: "연결된 메모", noteIds: ids }];
  });
  return {
    source: {
      ...source,
      notes: source.notes.filter((n) => wanted.has(n.id)),
      bundles: [],
      bundleLinks: [],
    },
    board: {
      ...board,
      filter: { topics: [], tags: [], categories: [], books: [], q: "" },
      groups: shown,
      positions,
      groupPositions,
    },
  };
}
