import type { Book, Note, ReadingCycle, Revision } from "../domain";
export type RawRecord = Record<string, any>;
export const serialized = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export const iso = (value: unknown) => new Date(String(value)).toISOString();
export function binaryCompare(a: string, b: string): number {
  let i = 0,
    j = 0;
  while (i < a.length && j < b.length) {
    const x = a.codePointAt(i)!,
      y = b.codePointAt(j)!;
    if (x !== y) return x < y ? -1 : 1;
    i += x > 65535 ? 2 : 1;
    j += y > 65535 ? 2 : 1;
  }
  return i < a.length ? 1 : j < b.length ? -1 : 0;
}
export function timestampKey(value: unknown): string {
  const text = String(value),
    fraction = (text.match(/\.(\d+)/)?.[1] ?? "").padEnd(6, "0").slice(0, 6);
  return iso(value).slice(0, 19) + "." + fraction;
}
export function sqlTimestamp(value: unknown): string {
  const key = timestampKey(value),
    fraction = key.slice(20).replace(/0+$/, "");
  return (
    key.slice(0, 19).replace("T", " ") +
    (fraction ? "." + fraction : "") +
    "+00"
  );
}
export function localDay(value: string): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}
function source(source: any, kind: "book" | "note") {
  if (source == null) return null;
  return {
    app: source.app ?? null,
    libraryId: source.libraryId ?? null,
    recordId: source.recordId ?? null,
    ...(kind === "book" ? { cover: source.cover ?? null } : {}),
    raw:
      kind === "note" && source.app === "PDF"
        ? {
            signature: source.raw?.signature ?? null,
            pdfPage: source.raw?.pdfPage ?? null,
          }
        : {},
  };
}
export function projectBook(r: RawRecord, compact = false): Book {
  return serialized({
    id: r.id,
    title: r.title,
    author: r.author,
    publisher: r.publisher,
    isbn: r.isbn,
    formats: r.formats,
    totalPages: r.total_pages,
    shelf: r.shelf,
    tags: r.tags,
    category: r.category,
    classification: r.classification,
    bookshelves: r.bookshelves,
    coverUrl: r.cover_url,
    enrichment: compact
      ? { catalogSelection: r.enrichment?.catalogSelection ?? null }
      : r.enrichment,
    version: r.version,
    createdAt: iso(r.created_at),
    sourceData: compact ? source(r.source_data, "book") : r.source_data,
  });
}
export function projectNote(r: RawRecord, compact = false): Note {
  return serialized({
    id: r.id,
    bookId: r.book_id,
    title: r.title,
    content: compact
      ? Array.from(String(r.content)).slice(0, 240).join("")
      : r.content,
    kind: r.kind,
    page: r.page,
    tags: r.tags,
    version: r.version,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    sourceData: compact ? source(r.source_data, "note") : r.source_data,
    ...(compact ? { summary: true } : {}),
  });
}
export function projectCycle(r: RawRecord): ReadingCycle {
  return {
    id: r.id,
    bookId: r.book_id,
    status: r.status,
    startedOn: r.started_on,
    completedOn: r.completed_on,
    currentPage: r.current_page,
    version: r.version,
    createdAt: iso(r.created_at),
  };
}
export function projectRevision(r: RawRecord): Revision {
  return {
    id: r.id,
    entityId: r.entity_id,
    action: r.action,
    before: r.before_data,
    after: r.after_data,
    createdAt: iso(r.created_at),
  };
}
export function jsonbText(value: any): string {
  if (Array.isArray(value)) return "[" + value.map(jsonbText).join(", ") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort(
          (a, b) =>
            new TextEncoder().encode(a).length -
              new TextEncoder().encode(b).length || binaryCompare(a, b),
        )
        .map((k) => JSON.stringify(k) + ": " + jsonbText(value[k]))
        .join(", ") +
      "}"
    );
  return JSON.stringify(value);
}
