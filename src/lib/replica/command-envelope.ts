import type { OutboxEntry } from "./contracts";
import type { Book, Note } from "../domain";
export function formEditBase(value: Book | Note) {
  return "formats" in value
    ? {
        title: value.title,
        author: value.author,
        publisher: value.publisher,
        isbn: value.isbn,
        formats: value.formats,
        total_pages: value.totalPages,
        shelf: value.shelf,
        tags: value.tags,
        category: value.category,
        bookshelves: value.bookshelves,
        cover_url: value.coverUrl,
      }
    : {
        book_id: value.bookId,
        title: value.title,
        content: value.content,
        kind: value.kind,
        page: value.page,
        tags: value.tags,
      };
}
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
