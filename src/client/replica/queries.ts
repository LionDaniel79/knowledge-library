import { z } from "zod";
import {
  buildTopicMaterials,
  materialCategory,
  pageTopicMaterials,
} from "../../lib/topic-materials";
import { categories } from "../../lib/catalog";
import {
  bookSearchFields,
  memoSearchFields,
  containsSearchField,
  containsBookTitleSearch,
} from "../../lib/search-fields";
import {
  monthCells,
  type Book,
  type Note,
  type ReadingCycle,
} from "../../lib/domain";
import {
  binaryCompare,
  localDay,
  type RawRecord,
} from "../../lib/replica/projections";
import { sha256Bytes } from "../../lib/replica/codec";
export interface IndexedBook {
  book: Book;
  createdKey: string;
  createdSql: string;
}
export interface SearchEntry {
  id: string;
  kind: string;
  source_id: string;
  version: string;
  title: string;
  body: string;
  voice: string;
  coverage: string;
  origin: string;
  tags: string;
  aux: number;
}
export interface LocalIndex {
  noteTimeKeys?: Record<string, { created: string; updated: string }>;
  connectionBooks?: string[];
  books: IndexedBook[];
  notes: Note[];
  previews: Record<string, Note>;
  cycles: ReadingCycle[];
  excluded: string[];
  trash: Record<string, string>;
  shelves: string[];
  annualMetrics: any[];
  topics: RawRecord[];
  memberships: RawRecord[];
  topicLinks: RawRecord[];
  entries: SearchEntry[];
}
export class ReplicaQueryError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const str = (fallback: string, max = 200) =>
  z.string().max(max).default(fallback);
const paging = {
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(24),
};
const bookQuery = z.object({
  q: z.string().trim().max(200).default(""),
  exclude: z.string().uuid().optional(),
  ...bookSearchFields,
  sort: z.enum(["newest", "oldest", "title", "author"]).default("newest"),
  category: z
    .enum([
      "all",
      "unclassified",
      "review",
      "000",
      "100",
      "200",
      "300",
      "400",
      "500",
      "600",
      "700",
      "800",
      "900",
    ])
    .default("all"),
  shelf: str("all", 80),
  filter: z
    .enum(["all", "reading", "completed", "paper", "pdf", "ebook", "unknown"])
    .default("all"),
  topic: z
    .union([z.enum(["all", "unclassified"]), z.string().uuid()])
    .default("all"),
  limit: paging.limit,
  offset: paging.offset,
  cursor: z.string().max(4000).optional(),
});
export function activeBooks(data: LocalIndex) {
  const excluded = new Set(data.excluded);
  return data.books.filter((b) => !excluded.has(b.book.id));
}
export function activeNotes(data: LocalIndex) {
  return data.notes.filter((n) => !Object.hasOwn(data.trash, n.id));
}
export function activeCycles(data: LocalIndex) {
  const excluded = new Set(data.excluded);
  return data.cycles.filter((c) => !excluded.has(c.bookId));
}
const encode = (value: unknown) =>
  btoa(encodeURIComponent(JSON.stringify(value)))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
const decode = (value: string) =>
  JSON.parse(
    decodeURIComponent(atob(value.replace(/-/g, "+").replace(/_/g, "/"))),
  );
// Server cursors are UTF-8 base64url, not URI-encoded strings.
export function encodeQueryCursor(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}
function decodeCursor(value: string) {
  return JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
        c.charCodeAt(0),
      ),
    ),
  );
}
const digest = (value: unknown) =>
  sha256Bytes(new TextEncoder().encode(JSON.stringify(value)));
function topicMatch(
  data: LocalIndex,
  kind: string,
  id: string,
  topic: string,
  bookId?: string | null,
) {
  if (topic === "all") return true;
  const active = new Set(
    data.topics.filter((t) => !t.archived_at).map((t) => t.id),
  );
  const direct = data.memberships.filter(
    (m) =>
      m.source_kind === kind && m.source_id === id && active.has(m.topic_id),
  );
  const rejected = new Set(
    direct.filter((m) => m.status === "rejected").map((m) => m.topic_id),
  );
  const assigned = [
    ...direct,
    ...(kind === "note" && bookId
      ? data.memberships.filter(
          (m) =>
            m.source_kind === "book" &&
            m.source_id === bookId &&
            active.has(m.topic_id),
        )
      : []),
  ].filter((m) => m.status !== "rejected" && !rejected.has(m.topic_id));
  return topic === "unclassified"
    ? !assigned.length
    : assigned.some((m) => m.topic_id === topic);
}
export async function queryBooks(
  data: LocalIndex,
  owner: string,
  input: unknown,
) {
  const { cursor, offset, ...q } = bookQuery.parse(input);
  if (cursor && offset)
    throw new ReplicaQueryError(
      400,
      "페이지 조회 방법을 하나만 선택해 주세요.",
    );
  const cycles = activeCycles(data),
    needle = q.q.toLowerCase(),
    compact = needle.replace(/\s+/g, "");
  const categoryIds = categories
    .filter(([, name]) => name.toLowerCase().includes(needle))
    .map(([id]) => id as string);
  let rows = activeBooks(data).filter(
    ({ book: b }) =>
      b.id !== q.exclude &&
      ["title", "author", "publisher", "isbn"].every((field) =>
        (field === "title" ? containsBookTitleSearch : containsSearchField)(
          b[field as keyof Book] as string,
          q[field as keyof typeof bookSearchFields],
        ),
      ) &&
      (!q.q ||
        [
          b.title,
          b.author,
          b.publisher,
          b.isbn,
          b.shelf,
          ...b.tags,
          ...(b.bookshelves ?? []),
        ]
          .join(" ")
          .toLowerCase()
          .includes(needle) ||
        containsBookTitleSearch(b.title, q.q) ||
        b.author.replace(/\s+/g, "").toLowerCase().includes(compact) ||
        categoryIds.includes(b.category ?? "")) &&
      (q.category === "all" ||
        (q.category === "unclassified"
          ? !b.category
          : q.category === "review"
            ? !!b.category && String(b.classification?.verified) !== "true"
            : b.category === q.category)) &&
      (q.shelf === "all" || b.bookshelves?.includes(q.shelf)) &&
      (q.filter === "all" ||
        (q.filter === "reading" || q.filter === "completed"
          ? cycles.some((c) => c.bookId === b.id && c.status === q.filter)
          : b.formats.includes(q.filter))) &&
      topicMatch(data, "book", b.id, q.topic),
  );
  const total = rows.length,
    fingerprint = await digest(["catalog-title/v3", owner, q]);
  const keys = (r: IndexedBook) =>
    q.sort === "title"
      ? [r.book.title, r.book.id]
      : q.sort === "author"
        ? [r.book.author, r.book.title, r.book.id]
        : [r.createdKey, r.book.id];
  const compare = (a: string[], b: string[]) => {
    for (let i = 0; i < a.length; i++) {
      const n = binaryCompare(a[i], b[i]);
      if (n) return n;
    }
    return 0;
  };
  const direction = q.sort === "newest" ? -1 : 1;
  rows.sort((a, b) => direction * compare(keys(a), keys(b)));
  if (cursor) {
    const c = decodeCursor(cursor);
    if (c.scope !== fingerprint || !Array.isArray(c.keys))
      throw new ReplicaQueryError(400, "목록 조건이 바뀌었습니다.");
    if (q.sort === "newest" || q.sort === "oldest") {
      const timestamp = String(c.keys[0]);
      const fraction = (timestamp.match(/\.(\d+)/)?.[1] ?? "")
        .padEnd(6, "0")
        .slice(0, 6);
      c.keys[0] =
        new Date(timestamp).toISOString().slice(0, 19) + "." + fraction;
    }
    rows = rows.filter((r) => direction * compare(keys(r), c.keys) > 0);
  }
  const selected = rows.slice(offset, offset + q.limit),
    last = selected.at(-1),
    nextCursor =
      rows.length > offset + q.limit && last
        ? encodeQueryCursor({
            scope: fingerprint,
            keys:
              q.sort === "title"
                ? [last.book.title, last.book.id]
                : q.sort === "author"
                  ? [last.book.author, last.book.title, last.book.id]
                  : [last.createdSql, last.book.id],
          })
        : null;
  return { items: selected.map((r) => r.book), total, nextCursor };
}
export function queryNotes(data: LocalIndex, input: unknown) {
  const p = z
      .object({
        category: z
          .string()
          .regex(/^all$|^\d00$/)
          .default("all"),
        topic: str("all"),
        q: z.string().trim().max(200).default(""),
        ...memoSearchFields,
        tag: str("all", 80),
        kind: str("all"),
        book: str("all"),
        from: str(""),
        to: str(""),
        ...paging,
      })
      .parse(input),
    needle = p.q.toLowerCase(),
    books = new Map(data.books.map((b) => [b.book.id, b.book]));
  const rows = activeNotes(data)
    .filter((n) => {
      const b = n.bookId ? books.get(n.bookId) : undefined,
        date = localDay(n.createdAt);
      return (
        (!needle ||
          [n.title, n.content, ...(n.tags ?? []), b?.title ?? ""]
            .join(" ")
            .toLowerCase()
            .includes(needle)) &&
        (p.tag === "all" ||
          (p.tag === "untagged" ? !n.tags?.length : n.tags?.includes(p.tag))) &&
        containsSearchField(n.title, p.title) &&
        containsSearchField(n.content, p.content) &&
        containsSearchField(b?.title, p.bookTitle) &&
        (p.kind === "all" ||
          (p.kind === "unclassified"
            ? n.title === "미분류 메모"
            : n.kind === p.kind)) &&
        (p.book === "all" ||
          (p.book === "unlinked" ? !n.bookId : n.bookId === p.book)) &&
        (!p.from || date >= p.from) &&
        (!p.to || date <= p.to) &&
        (p.category === "all" ||
          materialCategory(b?.category) === p.category) &&
        topicMatch(data, "note", n.id, p.topic, n.bookId)
      );
    })
    .sort(
      (a, b) =>
        binaryCompare(b.updatedAt, a.updatedAt) || binaryCompare(a.id, b.id),
    );
  const items = rows.slice(p.offset, p.offset + p.limit).map((n) => ({
    ...data.previews[n.id],
    bookCategory: n.bookId ? (books.get(n.bookId)?.category ?? null) : null,
  }));
  return {
    items,
    total: rows.length,
    nextOffset:
      p.offset + items.length < rows.length ? p.offset + items.length : null,
  };
}
export function readingSummary(data: LocalIndex) {
  const cycles = activeCycles(data).filter((c) => c.status === "completed"),
    dated = cycles
      .filter((c) => c.completedOn)
      .sort(
        (a, b) =>
          binaryCompare(a.completedOn!, b.completedOn!) ||
          binaryCompare(a.id, b.id),
      ),
    seen = new Set<string>(),
    months: Record<
      string,
      { monthCount: number; uniqueBooks: number; rereads: number }
    > = {},
    unique = new Map<string, Set<string>>();
  for (const c of dated) {
    const month = c.completedOn!.slice(0, 7),
      m = (months[month] ??= { monthCount: 0, uniqueBooks: 0, rereads: 0 }),
      set = unique.get(month) ?? new Set();
    m.monthCount++;
    if (seen.has(c.bookId)) m.rereads++;
    seen.add(c.bookId);
    set.add(c.bookId);
    unique.set(month, set);
    m.uniqueBooks = set.size;
    months[month] = m;
  }
  return {
    totalCompleted: cycles.length,
    undatedCount: cycles.filter((c) => !c.completedOn).length,
    completedIds: [...new Set(cycles.map((c) => c.bookId))].sort(binaryCompare),
    months,
  };
}
export function queryReading(data: LocalIndex, input: unknown) {
  const p = z
    .object({
      id: z.string().uuid().optional(),
      book: z.string().uuid().optional(),
      date: z.string().optional(),
      ...paging,
    })
    .parse(input);
  const rows = activeCycles(data)
    .filter(
      (c) =>
        (!p.id || c.id === p.id) &&
        (!p.book || c.bookId === p.book) &&
        (!p.date || c.completedOn === p.date),
    )
    .sort((a, b) =>
      a.completedOn === null && b.completedOn !== null
        ? -1
        : b.completedOn === null && a.completedOn !== null
          ? 1
          : binaryCompare(b.completedOn ?? "", a.completedOn ?? "") ||
            binaryCompare(a.id, b.id),
    );
  const items = rows.slice(p.offset, p.offset + p.limit),
    ids = new Set(items.map((c) => c.bookId));
  return {
    items,
    total: rows.length,
    books: data.books.filter((b) => ids.has(b.book.id)).map((b) => b.book),
    nextOffset:
      p.offset + items.length < rows.length ? p.offset + items.length : null,
  };
}
export function queryCalendar(data: LocalIndex, month: string) {
  const cells = monthCells(month),
    rows = activeCycles(data)
      .filter(
        (c) =>
          c.status === "completed" &&
          c.completedOn &&
          c.completedOn >= cells[0] &&
          c.completedOn <= cells.at(-1)!,
      )
      .sort(
        (a, b) =>
          binaryCompare(a.createdAt, b.createdAt) || binaryCompare(a.id, b.id),
      ),
    groups = new Map<string, ReadingCycle[]>();
  for (const c of rows) {
    const day = c.completedOn!;
    groups.set(day, [...(groups.get(day) ?? []), c]);
  }
  const days = [...groups]
      .sort(([a], [b]) => binaryCompare(a, b))
      .map(([, cycles]) => ({ ...cycles[0], total: cycles.length })),
    ids = new Set(days.map((c) => c.bookId));
  return {
    days,
    books: data.books.filter((b) => ids.has(b.book.id)).map((b) => b.book),
  };
}
export function searchContext(
  data: LocalIndex,
  q: {
    text: string;
    topicId?: string;
    topicScope?: string;
    expandAliases?: boolean;
  },
) {
  const topics = data.topics
      .filter((t) => t.confirmed)
      .sort(
        (a, b) => binaryCompare(a.name, b.name) || binaryCompare(a.id, b.id),
      ),
    scope = new Map<string, { id: string; name: string; relation: string }>();
  if (q.topicId) {
    const selected = topics.find((t) => t.id === q.topicId);
    if (!selected)
      throw new ReplicaQueryError(404, "확인된 주제를 찾을 수 없습니다.");
    scope.set(selected.id, {
      id: selected.id,
      name: selected.name,
      relation: "exact",
    });
    if (q.topicScope === "children" || q.topicScope === "related") {
      let changed = true;
      while (changed) {
        changed = false;
        for (const t of topics)
          if (t.parent_id && scope.has(t.parent_id) && !scope.has(t.id)) {
            scope.set(t.id, { id: t.id, name: t.name, relation: "child" });
            changed = true;
          }
      }
    }
    if (q.topicScope === "related")
      for (const link of data.topicLinks.filter(
        (l) =>
          l.status === "accepted" &&
          (l.source_topic_id === selected.id ||
            l.target_topic_id === selected.id),
      )) {
        const t = topics.find(
          (t) =>
            t.id ===
            (link.source_topic_id === selected.id
              ? link.target_topic_id
              : link.source_topic_id),
        );
        if (t && !scope.has(t.id))
          scope.set(t.id, { id: t.id, name: t.name, relation: "related" });
      }
  }
  const terms = [q.text];
  if (q.expandAliases && q.text)
    for (const t of topics) {
      const names = [t.name, ...(t.aliases ?? [])]
        .map((v: string) => v.trim())
        .filter(Boolean);
      if (names.some((n: string) => n.toLowerCase() === q.text.toLowerCase()))
        for (const n of names)
          if (
            !terms.some((v) => v.toLowerCase() === n.toLowerCase()) &&
            terms.length < 21
          )
            terms.push(n);
    }
  return { terms, scope };
}
export async function querySearch(
  data: LocalIndex,
  owner: string,
  input: unknown,
) {
  const q = z
      .object({
        text: z.string().trim().max(200),
        layer: z.enum(["all", "mine", "source", "auxiliary"]),
        topicId: z.string().uuid().optional(),
        topicScope: z.enum(["exact", "children", "related"]).optional(),
        expandAliases: z.boolean().optional(),
        cursor: z.string().max(500).optional(),
        limit: z.coerce.number().int().min(1).max(50).default(20),
        offset: z.coerce.number().int().min(0).max(100000).default(0),
      })
      .parse(input),
    context = searchContext(data, q),
    fingerprint = await digest([
      "title-spacing/v2",
      owner,
      q.text,
      q.layer,
      q.topicId ?? null,
      q.topicScope ?? "exact",
      q.expandAliases ?? false,
      context.terms,
      [...context.scope.values()],
    ]);
  let offset = q.offset;
  if (q.cursor) {
    const c = decodeCursor(q.cursor);
    if (
      c.key !== fingerprint ||
      !Number.isSafeInteger(c.offset) ||
      c.offset < 0
    )
      throw new ReplicaQueryError(400, "검색 조건이 바뀌었습니다.");
    offset = c.offset;
  }
  const lower = (s: string) => s.toLowerCase(),
    compact = (s: string) => lower(s).replace(/\s+/g, "");
  const rows = data.entries
    .flatMap((e) => {
      const terms = context.terms,
        match = terms.some(
          (t) =>
            lower([e.title, e.body, e.tags].join(" ")).includes(lower(t)) ||
            compact(e.title).includes(compact(t)),
        ),
        memberships = data.memberships.filter(
          (m) =>
            m.source_kind === e.kind &&
            m.source_id === e.source_id &&
            String(m.source_version) === e.version &&
            m.status === "accepted" &&
            context.scope.has(m.topic_id),
        );
      if (!match || (q.topicId && !memberships.length)) return [];
      const layer = e.aux
        ? "auxiliary"
        : e.voice === "self"
          ? "mine"
          : "source";
      if (q.layer !== "all" && q.layer !== layer) return [];
      const score = e.aux
        ? 10
        : e.voice === "self" &&
            terms.some((t) => lower(e.body).includes(lower(t)))
          ? 100
          : terms.some((t) => compact(e.title).includes(compact(t)))
            ? 80
            : 60;
      return [{ ...e, layer, score, memberships }];
    })
    .sort((a, b) => b.score - a.score || binaryCompare(a.id, b.id));
  return {
    total: rows.length,
    items: rows.slice(offset, offset + q.limit).map((r) => {
      const matchedTerms = context.terms.filter(
          (t) =>
            !!t &&
            (lower([r.title, r.body, r.tags].join(" ")).includes(lower(t)) ||
              compact(r.title).includes(compact(t))),
        ),
        start = Math.max(
          0,
          lower(r.body).indexOf(
            lower(
              matchedTerms.find((t) => lower(r.body).includes(lower(t))) ??
                q.text,
            ),
          ) - 100,
        );
      return {
        id: r.id,
        source: { kind: r.kind, id: r.source_id, version: r.version },
        layer: r.layer,
        title: r.title,
        quote: r.body.slice(start, start + 500),
        matchedTerms,
        topicMatches: r.memberships.map((m) => context.scope.get(m.topic_id)!),
        coverage: r.coverage,
        origin: r.origin,
        voice: r.voice,
      };
    }),
    nextCursor:
      rows.length > offset + q.limit
        ? encodeQueryCursor({ key: fingerprint, offset: offset + q.limit })
        : null,
  };
}
export function queryMaterials(data: LocalIndex, input: unknown) {
  return pageTopicMaterials(
    buildTopicMaterials({
      books: data.books.map((b) => b.book),
      notes: activeNotes(data),
      topics: data.topics.map((t) => ({
        id: t.id,
        name: t.name,
        archivedAt: t.archived_at,
      })),
      memberships: data.memberships.map((m) => ({
        topicId: m.topic_id,
        sourceKind: m.source_kind,
        sourceId: m.source_id,
        status: m.status,
      })),
      excludedBookIds: data.excluded,
      timeKeys: Object.fromEntries([
        ...data.books.map((b) => [
          `book:${b.book.id}`,
          { created: b.createdKey, updated: b.createdKey },
        ]),
        ...Object.entries(data.noteTimeKeys ?? {}).map(([id, value]) => [
          `note:${id}`,
          value,
        ]),
      ]),
    }),
    input,
  );
}
export type QueryKind =
  "books" | "notes" | "materials" | "reading" | "calendar" | "search";
export async function runLocalQuery(
  data: LocalIndex,
  owner: string,
  kind: QueryKind,
  input: any,
) {
  switch (kind) {
    case "materials":
      return queryMaterials(data, input);
    case "books":
      return queryBooks(data, owner, input);
    case "notes":
      return queryNotes(data, input);
    case "reading":
      return queryReading(data, input);
    case "calendar":
      return queryCalendar(data, input);
    case "search":
      return querySearch(data, owner, input);
  }
}
