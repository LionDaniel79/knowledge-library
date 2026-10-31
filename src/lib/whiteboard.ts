import { z } from "zod";
import type { Book, Note } from "./domain";
import { contentHash } from "./thought-map/records";
import { containsSearchField } from "./search-fields";
import type { MemoBundle, BundleLink } from "./thought-bundles";
import { projectSharedBoxes } from "./shared-thought-boxes";
import {
  boxNotes,
  boxNodeId,
  BOX_NOTE_TOP,
  BOX_NOTE_DX,
  BOX_NOTE_DY,
} from "./thought-boxes";

export const WHITEBOARD_ID = "00000000-0000-4000-8000-000000000001";
export const NOTE_WIDTH = 220,
  NOTE_HEIGHT = 166;
const point = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
  })
  .strict();
const groupId = z
  .string()
  .regex(/^(unclassified|(topic|manual|bundle):[a-f0-9-]{36})$/i);
export const boardFilterSchema = z
  .object({
    topics: z
      .array(z.union([z.string().uuid(), z.literal("unclassified")]))
      .max(20000),
    tags: z.array(z.string().max(100)).max(20000),
    categories: z.array(z.string().max(50)).max(30),
    books: z.array(z.string().uuid()).max(500),
    q: z.string().max(500),
  })
  .strict();
export const writingMaterialSchema = z
  .object({
    id: z.string().uuid(),
    order: z.number().int().min(1).max(100000),
    kind: z.enum(["note", "notes", "topics"]),
    label: z.string().max(300),
    noteIds: z.array(z.string().uuid()).max(5000),
    groupIds: z.array(groupId).max(1000),
  })
  .strict();
export const writingChapterSchema = z
  .object({
    bundleId: z.string().uuid().optional(),
    sourceBox: z
      .object({ boardId: z.string().uuid(), chapterId: z.string().uuid() })
      .strict()
      .optional(),
    id: z.string().uuid(),
    order: z.number().int().min(1).max(100000),
    title: z.string().max(300),
    text: z.string().max(20000),
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().min(300).max(10000),
    height: z.number().min(200).max(100000),
    items: z.array(writingMaterialSchema).max(5000),
  })
  .strict();
export const boardSchema = z
  .object({
    schema: z.literal(1),
    filter: boardFilterSchema,
    positions: z
      .record(z.string().min(1).max(260), point)
      .refine((v) => Object.keys(v).length <= 10000),
    groupPositions: z
      .record(groupId, point)
      .refine((v) => Object.keys(v).length <= 1000),
    groups: z
      .array(
        z
          .object({
            id: groupId.refine((v) => v.startsWith("manual:")),
            title: z.string().trim().min(1).max(80),
            noteIds: z.array(z.string().uuid()).min(1).max(5000),
          })
          .strict(),
      )
      .max(1000),
    collapsed: z.array(groupId).max(1000),
    links: z
      .array(z.object({ source: groupId, target: groupId }).strict())
      .max(5000),
    hiddenNoteIds: z.array(z.string().uuid()).max(10000).optional(),
    writing: z
      .object({
        excludedNoteIds: z.array(z.string().uuid()).max(10000).optional(),
        chapters: z.array(writingChapterSchema).max(500),
        viewport: z
          .object({
            x: z.number().finite(),
            y: z.number().finite(),
            zoom: z.number().min(0.1).max(1.8),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (new TextEncoder().encode(JSON.stringify(b)).byteLength > 384 * 1024)
      ctx.addIssue({
        code: "custom",
        message: "화이트보드 배치가 너무 큽니다.",
      });
    const notes = new Set<string>(),
      groups = new Set<string>(),
      links = new Set<string>();
    for (const g of b.groups) {
      if (groups.has(g.id))
        ctx.addIssue({ code: "custom", message: "중복 묶음입니다." });
      groups.add(g.id);
      for (const id of g.noteIds) {
        if (notes.has(id))
          ctx.addIssue({
            code: "custom",
            message: "한 메모는 수동 묶음 하나에만 넣을 수 있습니다.",
          });
        notes.add(id);
      }
    }
    for (const l of b.links) {
      const key = [l.source, l.target].sort().join("|");
      if (l.source === l.target || links.has(key))
        ctx.addIssue({
          code: "custom",
          message: "중복 또는 자기 묶음 연결입니다.",
        });
      links.add(key);
    }
  });
export type Board = z.infer<typeof boardSchema>;
export type BoardFilter = z.infer<typeof boardFilterSchema>;
export type Point = { x: number; y: number };
export type BoardConnection = {
  title?: string;
  id: string;
  source_kind: string;
  source_id: string;
  target_kind: string;
  target_id: string;
  relation: string;
  reason: string;
  status: string;
  version: number;
};
export function publicBoardConnection(
  row: Record<string, any>,
): BoardConnection {
  return Object.fromEntries(
    [
      "id",
      "source_kind",
      "source_id",
      "target_kind",
      "target_id",
      "relation",
      "reason",
      "status",
      "version",
      ...(row.title === undefined ? [] : ["title"]),
    ].map((k) => [k, row[k]]),
  ) as unknown as BoardConnection;
}
export interface WhiteboardSnapshot {
  bundles?: MemoBundle[];
  bundleLinks?: BundleLink[];
  board: { id: string; data: Board; version: number } | null;
  resolutionToken?: string;
  notes: Note[];
  books: (Pick<Book, "id" | "title" | "author"> & Partial<Book>)[];
  topics: { id: string; name: string; version: number }[];
  memberships: {
    topicId: string;
    sourceKind: string;
    sourceId: string;
    status: string;
  }[];
  connections: BoardConnection[];
  topicLinks?: {
    id: string;
    sourceTopicId: string;
    targetTopicId: string;
    status: string;
    version?: number;
  }[];
}
// JSONB may reorder object keys; known own saves must match their later reads.
export function boardStamp(row: WhiteboardSnapshot["board"]): string {
  function canonical(v: any): any {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, canonical(v[k])]),
      );
    return v;
  }
  return row
    ? `${row.version}:${contentHash(JSON.stringify(canonical(row.data)))}`
    : "absent";
}
export interface BoardNode extends Point {
  chapterId?: string;
  itemId?: string;
  order?: number;
  id: string;
  noteId: string;
  groupId: string | null;
  note: Note;
}
export interface BoardGroup extends Point {
  id: string;
  title: string;
  collapsed: boolean;
  width: number;
  height: number;
  nodes: BoardNode[];
  allNodes: BoardNode[];
}
export const emptyBoard = (): Board => ({
  schema: 1,
  filter: { topics: [], tags: [], categories: [], books: [], q: "" },
  positions: {},
  groupPositions: {},
  groups: [],
  collapsed: [],
  links: [],
  hiddenNoteIds: [],
});
const normalized = (s: string) =>
  s.normalize("NFKC").toLocaleLowerCase().trim();
export function noteTopics(source: WhiteboardSnapshot, n: Note) {
  const valid = new Set(source.topics.map((t) => t.id));
  return [
    ...new Set(
      source.memberships
        .filter(
          (m) =>
            m.status === "accepted" &&
            valid.has(m.topicId) &&
            ((m.sourceKind === "note" && m.sourceId === n.id) ||
              (m.sourceKind === "book" && m.sourceId === n.bookId)),
        )
        .map((m) => m.topicId),
    ),
  ];
}
function assignedTopics(source: WhiteboardSnapshot) {
  const valid = new Set(source.topics.map((t) => t.id)),
    byNote = new Map<string, Set<string>>(),
    byBook = new Map<string, Set<string>>();
  for (const m of source.memberships) {
    if (m.status !== "accepted" || !valid.has(m.topicId)) continue;
    const map =
      m.sourceKind === "note"
        ? byNote
        : m.sourceKind === "book"
          ? byBook
          : null;
    if (!map) continue;
    const ids = map.get(m.sourceId) ?? new Set<string>();
    ids.add(m.topicId);
    map.set(m.sourceId, ids);
  }
  return new Map(
    source.notes.map((n) => [
      n.id,
      [
        ...new Set([
          ...(byNote.get(n.id) ?? []),
          ...(n.bookId ? (byBook.get(n.bookId) ?? []) : []),
        ]),
      ],
    ]),
  );
}
export function filterNotes(
  source: WhiteboardSnapshot,
  f: BoardFilter,
  assigned?: Map<string, string[]>,
) {
  assigned ??= f.topics.length ? assignedTopics(source) : undefined;
  const books = new Map(source.books.map((b) => [b.id, b]));
  return source.notes.filter((n) => {
    const book = n.bookId ? books.get(n.bookId) : undefined,
      text = normalized(n.title + "\n" + n.content),
      topics = f.topics.length ? (assigned!.get(n.id) ?? []) : [];
    return (
      (!f.topics.length ||
        (!topics.length && f.topics.includes("unclassified")) ||
        topics.some((id) => f.topics.includes(id))) &&
      (!f.tags.length || f.tags.some((t) => (n.tags ?? []).includes(t))) &&
      (!f.books.length || (!!n.bookId && f.books.includes(n.bookId))) &&
      (!f.categories.length ||
        f.categories.includes(book?.category || "unclassified")) &&
      containsSearchField(text, normalized(f.q))
    );
  });
}
export function buildScene(
  source: WhiteboardSnapshot,
  b: Board,
  options: { plain?: boolean } = {},
) {
  b = projectSharedBoxes(b, source);
  const chapterItems =
    b.writing?.chapters.flatMap((c) => boxNotes(c, source)) ?? [];
  const chapterNotes = new Set(chapterItems.flatMap((i) => i.noteIds));
  const hidden = new Set(
    b.writing?.excludedNoteIds === undefined
      ? (b.hiddenNoteIds ?? [])
      : b.writing.excludedNoteIds.filter((id) => !chapterNotes.has(id)),
  );
  const chapterGrouped = new Set(
    chapterItems.filter((i) => i.groupIds.length).flatMap((i) => i.noteIds),
  );
  const assigned = assignedTopics(source);
  const visible = new Set(
      [
        ...filterNotes(source, b.filter, assigned),
        ...source.notes.filter((n) => chapterNotes.has(n.id)),
      ]
        .filter((n) => !hidden.has(n.id))
        .map((n) => n.id),
    ),
    notes = new Map(source.notes.map((n) => [n.id, n])),
    manual = new Set([
      ...b.groups.flatMap((g) => g.noteIds),
      ...(source.bundles ?? [])
        .filter((g) => !g.archived_at && b.groupPositions["bundle:" + g.id])
        .flatMap((g) => g.note_ids),
    ]),
    definitions: { id: string; title: string; ids: string[] }[] = b.groups.map(
      (g) => ({
        id: g.id,
        title: g.title,
        ids: g.noteIds.filter((id) => notes.has(id) && !chapterNotes.has(id)),
      }),
    );
  for (const bundle of source.bundles ?? [])
    if (!bundle.archived_at && b.groupPositions["bundle:" + bundle.id])
      definitions.push({
        id: "bundle:" + bundle.id,
        title: bundle.title,
        ids: bundle.note_ids.filter((id) => notes.has(id)),
      });
  const chapterGroupIds = new Set(chapterItems.flatMap((i) => i.groupIds));
  const allTopics =
    !b.filter.topics.length ||
    (b.filter.topics.includes("unclassified") &&
      source.topics.every((t) => b.filter.topics.includes(t.id)));
  if (!options.plain && (allTopics || chapterGroupIds.size)) {
    for (const t of source.topics)
      if (allTopics || chapterGroupIds.has(`topic:${t.id}`))
        definitions.push({
          id: `topic:${t.id}`,
          title: t.name,
          ids: source.notes
            .filter(
              (n) =>
                !manual.has(n.id) &&
                (!chapterNotes.has(n.id) || chapterGrouped.has(n.id)) &&
                assigned.get(n.id)!.includes(t.id),
            )
            .map((n) => n.id),
        });
    if (allTopics || chapterGroupIds.has("unclassified"))
      definitions.push({
        id: "unclassified",
        title: "미분류",
        ids: source.notes
          .filter(
            (n) =>
              !manual.has(n.id) &&
              (!chapterNotes.has(n.id) || chapterGrouped.has(n.id)) &&
              !assigned.get(n.id)!.length,
          )
          .map((n) => n.id),
      });
  }
  const grouped = new Set(definitions.flatMap((g) => g.ids));
  const groups: BoardGroup[] = [],
    nodes: BoardNode[] = [];
  const columnHeights = [30, 30];
  let i = -1;
  for (const g of definitions) {
    if (!g.ids.length) continue;
    i++;
    const origin = b.groupPositions[g.id] ?? {
      x: 30 + (i % 2) * 800,
      y: columnHeights[i % 2],
    };
    columnHeights[i % 2] = Math.max(
      columnHeights[i % 2],
      origin.y +
        Math.max(240, 236 + (Math.ceil(g.ids.length / 3) - 1) * 182) +
        45,
    );
    if (!g.ids.some((id) => visible.has(id))) continue;
    const allNodes = g.ids.map((noteId, j) => {
      const id = `${g.id}::${noteId}`,
        p = b.positions[id] ?? {
          x: origin.x + 16 + (j % 3) * 236,
          y: origin.y + 54 + Math.floor(j / 3) * 182,
        };
      return { id, noteId, groupId: g.id, note: notes.get(noteId)!, ...p };
    });
    const shown = allNodes.filter((n) => visible.has(n.noteId)),
      collapsed = b.collapsed.includes(g.id);
    const x = Math.min(...shown.map((n) => n.x - 16)),
      y = Math.min(...shown.map((n) => n.y - 54));
    const width = collapsed
        ? 320
        : Math.max(320, ...shown.map((n) => n.x + NOTE_WIDTH + 16 - x)),
      height = collapsed
        ? 122
        : Math.max(240, ...shown.map((n) => n.y + NOTE_HEIGHT + 16 - y));
    groups.push({
      id: g.id,
      title: g.title,
      x,
      y,
      width,
      height,
      collapsed,
      nodes: shown,
      allNodes,
    });
    nodes.push(...shown);
  }
  const loose = source.notes.filter(
    (n) => visible.has(n.id) && !grouped.has(n.id) && !chapterNotes.has(n.id),
  );
  loose.forEach((note, j) => {
    const id = `note::${note.id}`,
      p = b.positions[id] ?? {
        x: 30 + (j % 5) * 242,
        y:
          (groups.length
            ? Math.max(...groups.map((g) => g.y + g.height)) + 40
            : 30) +
          Math.floor(j / 5) * 182,
      };
    nodes.push({ id, noteId: note.id, groupId: null, note, ...p });
  });
  for (const chapter of b.writing?.chapters ?? [])
    for (const [index, item] of boxNotes(chapter, source).entries()) {
      const noteId = item.noteIds[0],
        note = notes.get(noteId);
      if (!note || !visible.has(noteId)) continue;
      const id = boxNodeId(chapter.id, item.id, noteId);
      const legacy = b.positions[id]
        ? undefined
        : Object.entries(b.positions).find(
            ([key, p]) =>
              key.endsWith("::" + noteId) &&
              p.x >= chapter.x &&
              p.x < chapter.x + chapter.width &&
              p.y >= chapter.y + 120 &&
              p.y < chapter.y + chapter.height,
          )?.[1];
      nodes.push({
        id,
        noteId,
        groupId: null,
        chapterId: chapter.id,
        itemId: item.id,
        order: item.order,
        note,
        ...(b.positions[id] ??
          legacy ?? {
            x: chapter.x + 20 + (index % 3) * BOX_NOTE_DX,
            y: chapter.y + BOX_NOTE_TOP + Math.floor(index / 3) * BOX_NOTE_DY,
          }),
      });
    }
  return { groups, nodes };
}
export function dropTarget(nodes: BoardNode[], moving: BoardNode, p: Point) {
  return (
    nodes
      .filter((n) => n.noteId !== moving.noteId)
      .flatMap((n) => {
        const dx = Math.max(0, n.x - p.x - NOTE_WIDTH, p.x - n.x - NOTE_WIDTH),
          dy = Math.max(0, n.y - p.y - NOTE_HEIGHT, p.y - n.y - NOTE_HEIGHT);
        const area =
          Math.max(
            0,
            Math.min(p.x + NOTE_WIDTH, n.x + NOTE_WIDTH) - Math.max(p.x, n.x),
          ) *
          Math.max(
            0,
            Math.min(p.y + NOTE_HEIGHT, n.y + NOTE_HEIGHT) - Math.max(p.y, n.y),
          );
        const distance = Math.hypot(dx, dy);
        return distance <= 36
          ? [
              {
                node: n,
                overlap: area >= NOTE_WIDTH * NOTE_HEIGHT * 0.2,
                score: distance - Math.min(area / 1000, 50),
              },
            ]
          : [];
      })
      .sort(
        (a, b) => a.score - b.score || a.node.id.localeCompare(b.node.id),
      )[0] ?? null
  );
}
export function moveNote(b: Board, node: BoardNode, p: Point): Board {
  return { ...b, positions: { ...b.positions, [node.id]: { ...p } } };
}
export function moveGroup(
  b: Board,
  g: BoardGroup,
  dx: number,
  dy: number,
): Board {
  return {
    ...b,
    groupPositions: {
      ...b.groupPositions,
      [g.id]: { x: g.x + dx, y: g.y + dy },
    },
    positions: {
      ...b.positions,
      ...Object.fromEntries(
        g.allNodes.map((n) => [n.id, { x: n.x + dx, y: n.y + dy }]),
      ),
    },
  };
}
export function mergeNotes(
  b: Board,
  from: BoardNode,
  to: BoardNode,
  newId: string,
  origin?: Point,
): Board {
  if (from.noteId === to.noteId) return b;
  const existing = b.groups.find((g) => g.noteIds.includes(to.noteId)),
    id = existing?.id ?? newId;
  const ids = [
    ...new Set([...(existing?.noteIds ?? [to.noteId]), from.noteId]),
  ];
  const groups = b.groups
    .filter((g) => g.id !== id)
    .map((g) => ({
      ...g,
      noteIds: g.noteIds.filter((n) => n !== from.noteId && n !== to.noteId),
    }))
    .filter((g) => g.noteIds.length);
  groups.push({ id, title: existing?.title ?? "메모 묶음", noteIds: ids });
  const p = origin ?? { x: to.x - 16, y: to.y - 54 };
  return {
    ...b,
    groups,
    collapsed: [...new Set([...b.collapsed, id])],
    groupPositions: { ...b.groupPositions, [id]: p },
    positions: {
      ...b.positions,
      ...Object.fromEntries(
        ids.map((noteId, j) => [
          `${id}::${noteId}`,
          {
            x: p.x + 16 + (j % 3) * 236,
            y: p.y + 54 + Math.floor(j / 3) * 182,
          },
        ]),
      ),
    },
  };
}
export function connectGroups(b: Board, source: string, target: string): Board {
  if (
    source === target ||
    b.links.some(
      (l) =>
        [l.source, l.target].includes(source) &&
        [l.source, l.target].includes(target),
    )
  )
    return b;
  return { ...b, links: [...b.links, { source, target }] };
}
export function connectionForPair(
  connections: BoardConnection[],
  source: string,
  target: string,
) {
  return connections.find(
    (c) =>
      c.source_kind === "note" &&
      c.target_kind === "note" &&
      ((c.source_id === source && c.target_id === target) ||
        (c.source_id === target && c.target_id === source)),
  );
}
export const boardSaveSchema = z
  .object({
    boardId: z.string().uuid().optional(),
    expectedVersion: z.number().int().nonnegative(),
    data: boardSchema,
    includeVisibility: z.boolean().optional(),
  })
  .strict();
export const boardNoteLinkSchema = z
  .object({ sourceId: z.string().uuid(), targetId: z.string().uuid() })
  .strict()
  .refine((v) => v.sourceId !== v.targetId, {
    message: "다른 메모를 선택해 주세요.",
  });
export function seedBoard(source: WhiteboardSnapshot, b: Board): Board {
  if (b.hiddenNoteIds === undefined)
    b = { ...b, hiddenNoteIds: source.board?.data.hiddenNoteIds ?? [] };
  const all = buildScene(source, {
      ...b,
      filter: { topics: [], tags: [], categories: [], books: [], q: "" },
    }),
    scene = buildScene(source, b);
  return {
    ...b,
    groupPositions: {
      ...Object.fromEntries(all.groups.map((g) => [g.id, { x: g.x, y: g.y }])),
      ...b.groupPositions,
    },
    positions: {
      ...Object.fromEntries(
        [...all.nodes, ...scene.nodes].map((n) => [n.id, { x: n.x, y: n.y }]),
      ),
      ...b.positions,
    },
  };
}

// A search is a fresh view of the matching memos, not a window into the gaps
// occupied by every other memo. Only matching placements are changed.
export function arrangeSearchResults(
  source: WhiteboardSnapshot,
  b: Board,
): Board {
  b = projectSharedBoxes(b, source);
  const pinned = new Set(
    b.writing?.chapters.flatMap((c) => c.items.flatMap((i) => i.noteIds)) ?? [],
  );
  const complete = buildScene(source, b);
  const scene = {
      groups: complete.groups.filter(
        (g) => !g.nodes.some((n) => pinned.has(n.noteId)),
      ),
      nodes: complete.nodes.filter((n) => !pinned.has(n.noteId)),
    },
    positions = { ...b.positions },
    groupPositions = { ...b.groupPositions },
    dx = NOTE_WIDTH + 48,
    dy = NOTE_HEIGHT + 48;
  const sizes = scene.groups.map((g) => {
    const columns = Math.min(3, g.nodes.length),
      rows = Math.ceil(g.nodes.length / 3);
    return {
      width: g.collapsed
        ? 320
        : Math.max(320, 32 + NOTE_WIDTH + (columns - 1) * dx),
      height: g.collapsed
        ? 122
        : Math.max(240, 70 + NOTE_HEIGHT + (rows - 1) * dy),
    };
  });
  const stride = Math.max(320, ...sizes.map((s) => s.width)) + 40,
    base = Math.max(
      30,
      ...(b.writing?.chapters.map((c) => c.y + c.height + 40) ?? []),
    ),
    heights = [base, base];
  scene.groups.forEach((g, i) => {
    const column = i % 2,
      origin = { x: 30 + column * stride, y: heights[column] };
    groupPositions[g.id] = origin;
    heights[column] += sizes[i].height + 40;
    g.nodes.forEach((n, j) => {
      positions[n.id] = {
        x: origin.x + 16 + (j % 3) * dx,
        y: origin.y + 54 + Math.floor(j / 3) * dy,
      };
    });
  });
  const top = scene.groups.length ? Math.max(...heights) : base;
  scene.nodes
    .filter((n) => !n.groupId)
    .forEach((n, i) => {
      positions[n.id] = {
        x: 30 + (i % 5) * dx,
        y: top + Math.floor(i / 5) * dy,
      };
    });
  return { ...b, positions, groupPositions };
}

// Repair the old automatically seeded sparse search view once. User-positioned
// notes keep their saved layout; an explicit new search can arrange them.
export function repairSparseSearchLayout(
  source: WhiteboardSnapshot,
  b: Board,
): Board {
  if (
    !b.filter.q &&
    ![b.filter.topics, b.filter.tags, b.filter.categories, b.filter.books].some(
      (v) => v.length,
    )
  )
    return b;
  const scene = buildScene(source, b);
  if (scene.nodes.length < 2) return b;
  const width =
      Math.max(...scene.nodes.map((n) => n.x + NOTE_WIDTH)) -
      Math.min(...scene.nodes.map((n) => n.x)),
    height =
      Math.max(...scene.nodes.map((n) => n.y + NOTE_HEIGHT)) -
      Math.min(...scene.nodes.map((n) => n.y));
  if (width <= 1600 && height <= 1200) return b;
  const original = seedBoard(source, emptyBoard());
  if (
    scene.nodes.some((n) => {
      const p = original.positions[n.id];
      return !p || Math.abs(p.x - n.x) > 0.5 || Math.abs(p.y - n.y) > 0.5;
    })
  )
    return b;
  return arrangeSearchResults(source, b);
}
