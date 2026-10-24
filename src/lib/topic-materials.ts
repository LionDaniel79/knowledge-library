import type { Book, Note } from "./domain";
import { materialPageQuery } from "./material-query";
import { categories } from "./catalog";
export interface TopicMaterial {
  id: string;
  kind: "note" | "book";
  title: string;
  text: string;
  category: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  bookId: string | null;
  bookTitle: string;
  topicIds: string[];
  topicNames: string[];
}
type SearchMaterial = TopicMaterial & { searchText?: string };
export type MaterialTopic = {
  id: string;
  name: string;
  archivedAt?: string | null;
};
export type MaterialMembership = {
  topicId: string;
  sourceKind: string;
  sourceId: string;
  status: string;
};
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export const materialCategory = (value?: string | null) => {
  const code = value?.trim() ?? "";
  return /^\d{3}(\.|$)/.test(code) ? code[0] + "00" : "";
};
export function buildTopicMaterials({
  books,
  notes,
  topics,
  memberships,
  excludedBookIds = [],
}: {
  books: Book[];
  notes: Note[];
  topics: MaterialTopic[];
  memberships: MaterialMembership[];
  excludedBookIds?: string[];
}): SearchMaterial[] {
  const byBook = new Map(books.map((b) => [b.id, b]));
  const activeTopics = new Map(
    topics.filter((t) => !t.archivedAt).map((t) => [t.id, t]),
  );
  const bySource = new Map<string, MaterialMembership[]>();
  for (const m of memberships) {
    if (!activeTopics.has(m.topicId)) continue;
    const key = `${m.sourceKind}:${m.sourceId}`,
      list = bySource.get(key) ?? [];
    list.push(m);
    bySource.set(key, list);
  }
  function topicFields(
    kind: "note" | "book",
    id: string,
    bookId?: string | null,
  ) {
    const direct = bySource.get(`${kind}:${id}`) ?? [];
    const rejected = new Set(
      direct.filter((m) => m.status === "rejected").map((m) => m.topicId),
    );
    const effective = [
      ...direct,
      ...(kind === "note" && bookId
        ? (bySource.get(`book:${bookId}`) ?? [])
        : []),
    ];
    const ids = [
      ...new Set(
        effective
          .filter((m) => m.status !== "rejected" && !rejected.has(m.topicId))
          .map((m) => m.topicId),
      ),
    ];
    ids.sort(
      (a, b) =>
        compare(activeTopics.get(a)!.name, activeTopics.get(b)!.name) ||
        compare(a, b),
    );
    return {
      topicIds: ids,
      topicNames: ids.map((id) => activeTopics.get(id)!.name),
    };
  }
  const excluded = new Set(excludedBookIds);
  return [
    ...notes.map((n) => {
      const b = n.bookId ? byBook.get(n.bookId) : undefined;
      return {
        id: n.id,
        kind: "note" as const,
        title: n.title,
        text: n.content,
        category: materialCategory(b?.category),
        version: n.version,
        createdAt: n.createdAt,
        updatedAt: n.updatedAt,
        bookId: n.bookId,
        bookTitle: b?.title ?? "",
        ...topicFields("note", n.id, n.bookId),
        searchText: [
          n.title,
          n.content,
          ...(n.tags ?? []),
          b?.title ?? "",
        ].join(" "),
      };
    }),
    ...books
      .filter((b) => !excluded.has(b.id))
      .map((b) => ({
        id: b.id,
        kind: "book" as const,
        title: b.title,
        text: [b.author, b.publisher].filter(Boolean).join(" · "),
        category: materialCategory(b.category),
        version: b.version,
        createdAt: b.createdAt,
        updatedAt: b.createdAt,
        bookId: b.id,
        bookTitle: b.title,
        ...topicFields("book", b.id),
        searchText: [
          b.title,
          b.author,
          b.publisher,
          b.isbn,
          b.shelf,
          ...b.tags,
        ].join(" "),
      })),
  ];
}
export function pageTopicMaterials(materials: SearchMaterial[], raw: unknown) {
  const p = materialPageQuery.parse(raw),
    needle = p.q.toLowerCase(),
    compact = needle.replace(/\s+/g, ""),
    categoryIds = new Set<string>(
      categories
        .filter(([, name]) => name.toLowerCase().includes(needle))
        .map(([id]) => id),
    );
  const rows = materials.filter(
    (m) =>
      (p.kind === "all" || m.kind === p.kind) &&
      (p.category === "all" ||
        m.category === (p.category === "unclassified" ? "" : p.category)) &&
      (p.topic === "all" ||
        (p.topic === "unclassified"
          ? !m.topicIds.length
          : m.topicIds.includes(p.topic))) &&
      (!needle ||
        (m.searchText ?? [m.title, m.text, m.bookTitle].join(" "))
          .toLowerCase()
          .includes(needle) ||
        (m.kind === "book" &&
          (categoryIds.has(m.category) ||
            [m.title, m.text]
              .join(" ")
              .replace(/\s+/g, "")
              .toLowerCase()
              .includes(compact)))),
  );
  const date = (value: string) =>
    Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : "";
  const dates = new Map(
    rows.map((m) => [
      m,
      { created: date(m.createdAt), updated: date(m.updatedAt) },
    ]),
  );
  rows.sort((a, b) => {
    if (p.sort === "default") {
      const kinds = compare(
        a.kind === "note" ? "0" : "1",
        b.kind === "note" ? "0" : "1",
      );
      if (kinds) return kinds;
      return (
        (a.kind === "note"
          ? compare(dates.get(b)!.updated, dates.get(a)!.updated)
          : compare(a.title, b.title)) || compare(a.id, b.id)
      );
    }
    if (p.sort === "oldest")
      return (
        compare(dates.get(a)!.created, dates.get(b)!.created) ||
        compare(a.kind, b.kind) ||
        compare(a.id, b.id)
      );
    const key = (m: TopicMaterial) =>
      p.sort === "category"
        ? m.category
        : p.sort === "topic"
          ? (m.topicNames[0] ?? "")
          : p.sort === "book"
            ? m.bookTitle
            : "";
    return (
      compare(key(a) || "\uffff", key(b) || "\uffff") ||
      compare(dates.get(b)!.created, dates.get(a)!.created) ||
      compare(a.kind, b.kind) ||
      compare(a.id, b.id)
    );
  });
  return {
    total: rows.length,
    items: rows
      .slice(p.offset, p.offset + p.limit)
      .map(({ searchText: _search, ...m }) => ({
        ...m,
        text: m.text.slice(0, 350),
      })),
  };
}
