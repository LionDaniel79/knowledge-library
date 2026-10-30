import type { Board, WhiteboardSnapshot } from "./whiteboard";
import { arrangeSearchResults } from "./whiteboard";
import type { MemoBundle } from "./thought-bundles";
import {
  addThoughtBox,
  boxNotes,
  boxNodeId,
  BOX_NOTE_TOP,
  BOX_NOTE_DX,
  BOX_NOTE_DY,
} from "./thought-boxes";
import { noteContextId } from "./note-context";
import { contentHash } from "./thought-map/records";
import { z } from "zod";
export const thoughtPromotionInput = z
  .object({
    legacyToken: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export type LegacyBoxConflict = {
  id: string;
  title: string;
  extraNoteIds: string[];
};
const DEFAULT = "00000000-0000-4000-8000-000000000001";
type SavedBoard = { id: string; data: Board; version: number };
/** Only explicit sourceBox ancestry joins legacy records; title/content equality is never identity. */
export function planThoughtBoxPromotion(
  boards: SavedBoard[],
  existing: MemoBundle[],
  acceptedToken?: string,
) {
  const legacyToken = contentHash(
    JSON.stringify({
      boards: boards
        .map((b) => [b.id, b.version])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      bundles: existing
        .map((b) => [b.id, b.version])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    }),
  );
  const nodes = new Map(
    boards.flatMap((b) =>
      (b.data.writing?.chapters ?? []).map(
        (c) => [b.id + ":" + c.id, { board: b, chapter: c }] as const,
      ),
    ),
  );
  const identity = (key: string): string => {
    const seen = new Set<string>();
    let current = key;
    while (!seen.has(current)) {
      seen.add(current);
      const n = nodes.get(current);
      if (!n) return current.split(":").at(-1)!;
      if (n.chapter.bundleId) return n.chapter.bundleId;
      const ref = n.chapter.sourceBox;
      if (!ref) return n.chapter.id;
      current = ref.boardId + ":" + ref.chapterId;
    }
    const path = [...seen];
    return path.slice(path.indexOf(current)).sort()[0].split(":").at(-1)!;
  };
  const families = new Map<
    string,
    typeof nodes extends Map<string, infer V> ? V[] : never
  >();
  for (const [key, node] of nodes) {
    const id = identity(key);
    families.set(id, [...(families.get(id) ?? []), node]);
  }
  const created: MemoBundle[] = [],
    updated: MemoBundle[] = [],
    conflicts: LegacyBoxConflict[] = [],
    bundles = [...existing];
  for (const [id, family] of families) {
    const old = existing.find((b) => b.id === id);
    if (old) {
      const extraNoteIds = [
        ...new Set(
          family
            .filter((n) => !n.chapter.bundleId)
            .flatMap((n) => n.chapter.items.flatMap((i) => i.noteIds)),
        ),
      ].filter((id) => !old.note_ids.includes(id));
      if (extraNoteIds.length && !old.archived_at) {
        conflicts.push({ id, title: old.title, extraNoteIds });
        if (acceptedToken === legacyToken) {
          const changed = {
            ...old,
            note_ids: [...old.note_ids, ...extraNoteIds],
            version: old.version + 1,
          };
          bundles[bundles.findIndex((b) => b.id === id)] = changed;
          updated.push(changed);
        }
      }
      continue;
    }
    const origin =
      family.find((n) => n.chapter.id === id && !n.chapter.sourceBox) ??
      family[0];
    const record: MemoBundle = {
      id,
      title: (origin.chapter.title.trim() || "생각 묶음").slice(0, 300),
      description: origin.chapter.text,
      note_ids: [
        ...new Set(
          family.flatMap((n) => n.chapter.items.flatMap((i) => i.noteIds)),
        ),
      ],
      version: 1,
      archived_at: null,
    };
    created.push(record);
    bundles.push(record);
  }
  const normalized = boards.map((b) => {
    const seen = new Set<string>();
    const chapters = (b.data.writing?.chapters ?? []).flatMap((c) => {
      const id = identity(b.id + ":" + c.id);
      if (
        !c.bundleId &&
        conflicts.some((conflict) => conflict.id === id) &&
        acceptedToken !== legacyToken
      )
        return [c]; // Keep late additions visible until the owner explicitly merges them.
      if (seen.has(id)) return [];
      seen.add(id);
      return [{ ...c, bundleId: id }];
    });
    if (
      !b.data.writing ||
      JSON.stringify(chapters) === JSON.stringify(b.data.writing.chapters)
    )
      return b;
    return {
      ...b,
      data: { ...b.data, writing: { ...b.data.writing, chapters } },
    };
  });
  return {
    created,
    updated,
    bundles,
    boards: normalized,
    conflicts,
    legacyToken,
  };
}
export function sharedBoxSummaries(bundles: MemoBundle[]) {
  return bundles
    .filter((b) => !b.archived_at)
    .map((b, index) => ({
      id: b.id,
      bundleId: b.id,
      bundleVersion: b.version,
      boardId: DEFAULT,
      chapterId: b.id,
      boardTitle: "생각묶음",
      title: b.title,
      order: index + 1,
      noteCount: b.note_ids.length,
      boardVersion: b.version,
    }));
}
export function projectSharedBoxes(
  board: Board,
  source: WhiteboardSnapshot,
): Board {
  if (!board.writing) return board;
  const seen = new Set<string>();
  const chapters = board.writing.chapters.flatMap((c) => {
    if (!c.bundleId) return [c];
    if (seen.has(c.bundleId)) return [];
    seen.add(c.bundleId);
    const bundle = source.bundles?.find((b) => b.id === c.bundleId);
    if (!bundle) return [c];
    if (bundle.archived_at) return [];
    const old = boxNotes({ ...c, bundleId: undefined }, source),
      byNote = new Map(old.map((i) => [i.noteIds[0], i]));
    let order = Math.max(0, ...old.map((i) => i.order));
    return [
      {
        ...c,
        title: bundle.title,
        text: bundle.description,
        items: bundle.note_ids.map(
          (id) =>
            byNote.get(id) ?? {
              id: noteContextId(c.id, id, 0),
              order: ++order,
              kind: "note" as const,
              label: source.notes.find((n) => n.id === id)?.title || "메모",
              noteIds: [id],
              groupIds: [],
            },
        ),
      },
    ];
  });
  if (JSON.stringify(chapters) === JSON.stringify(board.writing.chapters))
    return board;
  return { ...board, writing: { ...board.writing, chapters } };
}
export function referenceThoughtBox(
  board: Board,
  bundle: MemoBundle,
  source: WhiteboardSnapshot,
): Board {
  if (
    board.writing?.chapters.some(
      (c) =>
        c.bundleId === bundle.id ||
        c.id === bundle.id ||
        (!c.bundleId && c.sourceBox?.chapterId === bundle.id),
    )
  )
    return board;
  const next = addThoughtBox(board, bundle.id, bundle.title),
    c = next.writing!.chapters.at(-1)!;
  c.bundleId = bundle.id;
  c.text = bundle.description;
  c.items = bundle.note_ids.map((id, index) => ({
    id: noteContextId(c.id, id, 0),
    order: index + 1,
    kind: "note",
    label: source.notes.find((n) => n.id === id)?.title || "메모",
    noteIds: [id],
    groupIds: [],
  }));
  const positions = { ...next.positions };
  c.items.forEach(
    (item, i) =>
      (positions[boxNodeId(c.id, item.id, item.noteIds[0])] = {
        x: c.x + 20 + (i % 3) * BOX_NOTE_DX,
        y: c.y + BOX_NOTE_TOP + Math.floor(i / 3) * BOX_NOTE_DY,
      }),
  );
  c.height = Math.max(
    220,
    BOX_NOTE_TOP + Math.ceil(c.items.length / 3) * BOX_NOTE_DY + 20,
  );
  return { ...next, positions };
}
export function arrangeThoughtBoard(
  board: Board,
  source: WhiteboardSnapshot,
): Board {
  let next = projectSharedBoxes(board, source);
  if (!next.writing?.chapters.length) return arrangeSearchResults(source, next);
  const columns = 2,
    heights = [24, 24],
    positions = { ...next.positions };
  const chapters = [...next.writing.chapters]
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map((c, index) => {
      const items = boxNotes(c, source).sort(
        (a, b) => a.order - b.order || a.id.localeCompare(b.id),
      );
      const count = Math.min(3, Math.max(1, items.length));
      const col = index % columns;
      const changed = {
        ...c,
        x: 24 + col * 810,
        y: heights[col],
        width: Math.max(360, 40 + 220 + (count - 1) * BOX_NOTE_DX),
        height: Math.max(
          220,
          BOX_NOTE_TOP + Math.ceil(items.length / count) * BOX_NOTE_DY + 20,
        ),
        items,
      };
      items.forEach(
        (item, i) =>
          (positions[boxNodeId(c.id, item.id, item.noteIds[0])] = {
            x: changed.x + 20 + (i % count) * BOX_NOTE_DX,
            y: changed.y + BOX_NOTE_TOP + Math.floor(i / count) * BOX_NOTE_DY,
          }),
      );
      heights[col] += changed.height + 40;
      return changed;
    });
  next = { ...next, positions, writing: { ...next.writing, chapters } };
  return arrangeSearchResults(source, next);
}
