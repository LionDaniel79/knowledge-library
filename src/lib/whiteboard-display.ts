import { buildScene, type Board, type WhiteboardSnapshot } from "./whiteboard";
import { noteContextId } from "./note-context";
import {
  projectSharedBoxes,
  referenceThoughtBox,
} from "./shared-thought-boxes";
import { thoughtView } from "./thought-boxes";
import { connectedMemoGroups } from "./memo-box";
import { bundleBoard } from "./thought-bundle-board";
export type BoardDisplaySelection = {
  connections: "all" | string[] | null;
  boxes: Record<string, boolean>;
  plain: boolean;
};

/** View operations never alter a saved original, membership, or board version. */
export function boardDisplaySelection(
  source: WhiteboardSnapshot,
  board: Board,
  selection: BoardDisplaySelection,
  writing: boolean,
  context?: {
    components: Map<string, string>;
    groups: ReturnType<typeof connectedMemoGroups>;
  },
) {
  let projected = projectSharedBoxes(board, source);
  const components =
    context?.components ??
    new Map(
      connectedMemoGroups(source).flatMap((g) =>
        g.notes.map((n) => [n.id, g.id] as const),
      ),
    );
  const groups: Board["groups"] = [],
    positions = { ...projected.positions };
  for (const g of projected.groups) {
    if (g.title !== "연결된 메모") {
      groups.push(g);
      continue;
    }
    const parts = new Map<string, string[]>();
    for (const id of g.noteIds) {
      const component = components.get(id);
      if (component)
        parts.set(component, [...(parts.get(component) ?? []), id]);
    }
    const kept = [...parts.values()].filter((ids) => ids.length > 1),
      retained = new Set(kept.flat());
    kept.forEach((ids, i) => {
      const key = i === 0 ? g.id : "manual:" + noteContextId(g.id, ids[0], 0);
      groups.push({ ...g, id: key, noteIds: ids });
      if (key !== g.id)
        for (const id of ids)
          if (positions[g.id + "::" + id])
            positions[key + "::" + id] = positions[g.id + "::" + id];
    });
    for (const id of g.noteIds)
      if (
        !retained.has(id) &&
        !positions["note::" + id] &&
        positions[g.id + "::" + id]
      )
        positions["note::" + id] = positions[g.id + "::" + id];
  }
  if (JSON.stringify(groups) !== JSON.stringify(projected.groups)) {
    const removed = new Set(
      projected.groups
        .filter((g) => !groups.some((value) => value.id === g.id))
        .map((g) => g.id),
    );
    projected = {
      ...projected,
      positions,
      groups,
      collapsed: projected.collapsed.filter((id) => !removed.has(id)),
      links: projected.links.filter(
        (l) => !removed.has(l.source) && !removed.has(l.target),
      ),
    };
  }
  const focus = selection.connections !== null;
  const chapters = (projected.writing?.chapters ?? []).filter((c) => {
    const id = c.bundleId ?? c.id;
    if (selection.boxes[id] === false) return false;
    if (!writing) return selection.boxes[id] === true;
    return true;
  });
  let display: Board = {
    ...projected,
    groupPositions: Object.fromEntries(
      Object.entries(projected.groupPositions).filter(
        ([id]) =>
          !id.startsWith("bundle:") ||
          (writing
            ? selection.boxes[id.slice(7)] !== false
            : selection.boxes[id.slice(7)] === true),
      ),
    ),
    writing: { ...projected.writing, chapters },
  };
  for (const bundle of source.bundles ?? [])
    if (!bundle.archived_at && selection.boxes[bundle.id] === true) {
      const order =
        Math.max(
          0,
          ...(projected.writing?.chapters ?? []).map((c) => c.order),
          ...(display.writing?.chapters ?? []).map((c) => c.order),
        ) + 1;
      const next = referenceThoughtBox(display, bundle, source);
      if (next !== display) next.writing!.chapters.at(-1)!.order = order;
      display = next;
    }
  display = bundleBoard(source, display);
  if (focus)
    return {
      ...thoughtView(source, display, selection.connections!, context?.groups),
      plain: false,
    };
  if (selection.plain && !writing) {
    const positions = { ...display.positions };
    const byNote = new Map<string, { x: number; y: number }>();
    for (const [key, value] of Object.entries(projected.positions)) {
      const at = key.lastIndexOf("::");
      if (at >= 0 && !byNote.has(key.slice(at + 2)))
        byNote.set(key.slice(at + 2), value);
    }
    for (const n of source.notes) {
      if (positions["note::" + n.id]) continue;
      const prior = byNote.get(n.id);
      if (prior) positions["note::" + n.id] = prior;
    }
    return {
      source: { ...source, bundles: [], bundleLinks: [] },
      board: {
        ...display,
        positions,
        groups: [],
        links: [],
        collapsed: [],
        writing: { ...display.writing, chapters: [] },
      },
      plain: true,
    };
  }
  return { source, board: display, plain: false };
}

export function arrangePlainMemos(
  source: WhiteboardSnapshot,
  display: Board,
  saved: Board,
) {
  const nodes = buildScene(source, display, { plain: true }).nodes;
  const positions = { ...saved.positions };
  nodes.forEach((n, i) => {
    positions["note::" + n.noteId] = {
      x: 24 + (i % 4) * 238,
      y: 24 + Math.floor(i / 4) * 194,
    };
  });
  return { ...saved, positions };
}
