import { z } from "zod";
import { emptyBoard, type Board, type Point } from "./whiteboard";
import { noteContextId } from "./note-context";

export const mergeWritingProjectsSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    sources: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            expectedTitle: z.string().max(300),
            expectedQuestion: z.string().max(2000),
            expectedBoardVersion: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .min(2)
      .max(50),
  })
  .strict()
  .refine(
    (p) => new Set(p.sources.map((s) => s.id)).size === p.sources.length,
    {
      message: "서로 다른 글감을 두 개 이상 선택해 주세요.",
    },
  );

/** Copies board references and geometry. Canonical boxes and memo records stay shared. */
export function mergeWritingBoards(
  sources: { id: string; data: Board }[],
): Board {
  const result = emptyBoard();
  result.writing = { chapters: [], excludedNoteIds: [] };
  const originals = new Set<string>(),
    manualNotes = new Set<string>();
  let chapterX = 24;
  const chapterMaps = sources.map((source) => {
    const ids = new Set<string>();
    for (const chapter of [...(source.data.writing?.chapters ?? [])].sort(
      (a, b) => a.order - b.order || a.id.localeCompare(b.id),
    )) {
      const bundleId = chapter.bundleId;
      const sourceBox = chapter.sourceBox ?? {
        boardId: source.id,
        chapterId: chapter.id,
      };
      const original = bundleId
        ? "bundle:" + bundleId
        : sourceBox.boardId + ":" + sourceBox.chapterId;
      if (originals.has(original)) continue;
      originals.add(original);
      const id = noteContextId(source.id, "merged-chapter:" + chapter.id, 0);
      ids.add(id);
      const copy = structuredClone(chapter);
      copy.id = id;
      copy.order = result.writing!.chapters.length + 1;
      copy.sourceBox = { ...sourceBox };
      copy.x = chapterX;
      copy.y = 24;
      result.writing!.chapters.push(copy);
      chapterX += copy.width + 48;
      for (const [key, point] of Object.entries(source.data.positions))
        if (key.startsWith(`chapter:${chapter.id}:`))
          result.positions[
            key.replace(`chapter:${chapter.id}:`, `chapter:${id}:`)
          ] = {
            x: copy.x + point.x - chapter.x,
            y: copy.y + point.y - chapter.y,
          };
    }
    return ids;
  });
  let freeX = 24;
  const freeY = Math.max(
    24,
    ...result.writing.chapters.map((c) => c.y + c.height + 48),
  );
  sources.forEach((source, sourceIndex) => {
    const data = source.data,
      renamed = new Map<string, string>();
    for (const group of data.groups) {
      const noteIds = group.noteIds.filter((id) => !manualNotes.has(id));
      if (!noteIds.length) continue;
      noteIds.forEach((id) => manualNotes.add(id));
      const id =
        "manual:" + noteContextId(source.id, "merged-group:" + group.id, 0);
      renamed.set(group.id, id);
      result.groups.push({ ...group, id, noteIds: [...noteIds] });
    }
    const freeEntries = Object.entries(data.positions).filter(
      ([key]) => !key.startsWith("chapter:"),
    );
    const points = [
      ...freeEntries.map(([, p]) => p),
      ...Object.values(data.groupPositions),
    ];
    const minX = Math.min(0, ...points.map((p) => p.x)),
      minY = Math.min(0, ...points.map((p) => p.y));
    const shift = (p: Point) => ({
      x: freeX + p.x - minX,
      y: freeY + p.y - minY,
    });
    for (const [key, p] of Object.entries(data.groupPositions)) {
      const id = renamed.get(key) ?? key;
      if (!result.groupPositions[id]) result.groupPositions[id] = shift(p);
    }
    for (const [key, p] of freeEntries) {
      const split = key.indexOf("::"),
        group = key.slice(0, split);
      const id = renamed.has(group)
        ? renamed.get(group) + key.slice(split)
        : key;
      if (!result.positions[id]) result.positions[id] = shift(p);
    }
    for (const group of data.collapsed) {
      const id = renamed.get(group) ?? group;
      if (!result.collapsed.includes(id)) result.collapsed.push(id);
    }
    for (const link of data.links) {
      const sourceId = renamed.get(link.source) ?? link.source,
        targetId = renamed.get(link.target) ?? link.target;
      if (
        sourceId !== targetId &&
        !result.links.some(
          (l) =>
            (l.source === sourceId && l.target === targetId) ||
            (l.source === targetId && l.target === sourceId),
        )
      )
        result.links.push({ source: sourceId, target: targetId });
    }
    // Preserve group references used by legacy materials after local group IDs change.
    for (const chapter of result.writing!.chapters)
      if (chapterMaps[sourceIndex].has(chapter.id))
        chapter.items = chapter.items.map((item) => ({
          ...item,
          groupIds: item.groupIds.map((id) => renamed.get(id) ?? id),
        }));
    freeX += Math.max(760, ...points.map((p) => p.x - minX + 260)) + 48;
  });
  // A note hidden everywhere stays hidden. Per-source filters are resolved by the server.
  result.hiddenNoteIds = [
    ...new Set(sources.flatMap((s) => s.data.hiddenNoteIds ?? [])),
  ].filter((id) =>
    sources.every((s) => (s.data.hiddenNoteIds ?? []).includes(id)),
  );
  return result;
}
