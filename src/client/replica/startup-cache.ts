import { z } from "zod";
import { formats, type Library } from "../../lib/domain";
// This small, disposable view supplements the complete IndexedDB replica. It
// contains no provider responses, credentials, original PDFs or editable drafts.
const text = z.string(),
  strings = z.array(text),
  number = z.number();
const source = z
  .object({
    app: text.nullish().transform((v) => v ?? ""),
    libraryId: text.nullish().transform((v) => v ?? ""),
    recordId: text.nullish().transform((v) => v ?? ""),
    cover: z
      .object({ sha256: text, mime: text, bytes: number })
      .nullish()
      .transform((v) => v ?? undefined),
  })
  .transform((s) => ({ ...s, raw: {} }));
const cover = text
  .transform((v) =>
    /^\/api\/(book-covers|import-assets)\//.test(v) ? v : undefined,
  )
  .optional();
const book = z.object({
  id: text,
  title: text,
  author: text,
  publisher: text,
  isbn: text,
  formats: z.array(z.enum(formats)),
  totalPages: number.nullable(),
  shelf: text,
  tags: strings,
  category: text.optional(),
  bookshelves: strings.optional(),
  coverUrl: cover,
  catalogCoverUrl: cover,
  storedCoverUrl: cover,
  storedImportedCoverUrl: cover,
  version: number,
  createdAt: text,
  sourceData: source.nullable().optional(),
});
const note = z.object({
  id: text,
  bookId: text.nullable(),
  title: text,
  content: text,
  kind: z.enum([
    "thought",
    "note",
    "highlight",
    "review",
    "claim",
    "evidence",
    "counterargument",
    "reflection",
  ]),
  page: number.nullable(),
  version: number,
  createdAt: text,
  updatedAt: text,
  tags: strings.optional(),
  summary: z.boolean().optional(),
});
const libraryView = z.object({
  books: z.array(book),
  notes: z.array(note),
  deletedNotes: z.array(note.extend({ deletedAt: text })).optional(),
  cycles: z.array(
    z.object({
      id: text,
      bookId: text,
      status: z.enum(["reading", "completed"]),
      startedOn: text.nullable(),
      completedOn: text.nullable(),
      currentPage: number,
      version: number,
      createdAt: text,
    }),
  ),
  shelves: strings.optional(),
  annualMetrics: z
    .array(
      z.object({
        year: number,
        reportedBooks: number,
        source: text,
        explanation: text,
      }),
    )
    .optional(),
  readingSummary: z
    .object({
      totalCompleted: number,
      undatedCount: number,
      completedIds: strings,
      months: z.record(
        text,
        z.object({ monthCount: number, uniqueBooks: number, rereads: number }),
      ),
    })
    .optional(),
  catalog: z
    .object({
      total: number,
      formatCounts: z.object({
        paper: number,
        logos: number.default(0),
        pdf: number,
        ebook: number,
        unknown: number,
      }),
      categoryCounts: z.record(text, number),
      firstPage: z.object({
        items: z.array(book),
        total: number,
        nextCursor: text.nullable(),
      }),
    })
    .optional(),
});
const snapshot = z.object({
  version: z.literal(1),
  owner: text,
  library: libraryView,
});
const key = (owner: string) =>
  "knowledge-library-startup:v1:" + encodeURIComponent(owner);
const limit = 1_000_000;
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export function readStartup(storage: Store, owner: string): Library | null {
  try {
    const raw = storage.getItem(key(owner));
    if (!raw || raw.length > limit) return null;
    const value = snapshot.parse(JSON.parse(raw));
    return value.owner === owner ? value.library : null;
  } catch {
    return null;
  }
}
export function writeStartup(storage: Store, owner: string, library: Library) {
  if (!owner) return;
  try {
    const value = JSON.stringify(
      snapshot.parse({ version: 1, owner, library }),
    );
    if (value.length <= limit) storage.setItem(key(owner), value);
    else clearStartup(storage, owner);
  } catch {
    clearStartup(storage, owner);
  }
}
export function clearStartup(storage: Store, owner: string) {
  try {
    storage.removeItem(key(owner));
  } catch {}
}
