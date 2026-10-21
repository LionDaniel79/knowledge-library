import { materialPageQuery } from "@/lib/material-query";
import type { Executor } from "./library-store";
import { readNotePage } from "./record-catalog";
import { readBookPage } from "./book-catalog";
export async function readMaterialPage(
  db: Executor,
  owner: string,
  raw: unknown,
) {
  // Material kind is separate from the note's own kind (thought, quote, etc.).
  const { kind, ...p } = materialPageQuery.parse(raw);
  const notes =
    kind === "book"
      ? { items: [], total: 0 }
      : await readNotePage(db, owner, p);
  const books =
    kind === "note"
      ? { items: [], total: 0 }
      : await readBookPage(db, owner, {
          ...p,
          sort: "title",
          offset: Math.max(0, p.offset - notes.total),
          limit: Math.max(1, p.limit - notes.items.length),
        });
  return {
    total: notes.total + books.total,
    items: [
      ...notes.items.map((n) => ({
        id: n.id,
        kind: "note" as const,
        title: n.title,
        text: n.content,
        category: n.bookCategory ?? "",
        version: n.version,
      })),
      ...books.items.slice(0, p.limit - notes.items.length).map((b) => ({
        id: b.id,
        kind: "book" as const,
        title: b.title,
        text: [b.author, b.publisher].filter(Boolean).join(" · "),
        category: b.category ?? "",
        version: b.version,
      })),
    ],
  };
}
