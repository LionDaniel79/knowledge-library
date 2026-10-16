import { z } from "zod";
import type { Executor } from "./library-store";
import { readNotePage } from "./record-catalog";
import { readBookPage } from "./book-catalog";
export async function readMaterialPage(
  db: Executor,
  owner: string,
  raw: unknown,
) {
  const p = z
    .object({
      q: z.string().trim().max(200).default(""),
      category: z
        .string()
        .regex(/^all$|^\d00$/)
        .default("all"),
      topic: z
        .union([z.enum(["all", "unclassified"]), z.string().uuid()])
        .default("all"),
      offset: z.coerce.number().int().min(0).max(1000000).default(0),
      limit: z.coerce.number().int().min(1).max(50).default(30),
    })
    .parse(raw);
  const notes = await readNotePage(db, owner, p);
  const books = await readBookPage(db, owner, {
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
