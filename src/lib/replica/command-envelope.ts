import type { OutboxEntry } from "./contracts";
export const editableFields = {
  library_books: [
    "title",
    "author",
    "publisher",
    "isbn",
    "formats",
    "total_pages",
    "shelf",
    "tags",
    "category",
    "bookshelves",
    "cover_url",
  ],
  library_notes: ["book_id", "title", "content", "kind", "page", "tags"],
} as const;
export function syncCommandEnvelope(entry: OutboxEntry) {
  const c = entry.command as { path: string; body: any; base?: any };
  const entity =
    c.path === "/api/library"
      ? c.body.type === "editBook"
        ? "library_books"
        : c.body.type === "editNote"
          ? "library_notes"
          : null
      : null;
  const precondition =
    entity && c.base
      ? {
          entity,
          id: entry.entityId,
          fields: Object.fromEntries(
            editableFields[entity]
              .filter((k) => Object.hasOwn(c.base, k))
              .map((k) => [k, c.base[k]]),
          ),
        }
      : undefined;
  return {
    ownerId: entry.owner,
    requestId: entry.requestId,
    family: entry.family,
    path: c.path,
    body: c.body,
    ...(precondition ? { precondition } : {}),
  };
}
