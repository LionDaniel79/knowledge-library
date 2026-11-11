import { z } from "zod";
import { catalogSelection } from "./catalog-selection";
import { noteContextFields } from "./note-context";
export const formats = ["paper", "logos", "ebook", "pdf", "unknown"] as const;
export type Format = (typeof formats)[number];
export const formatNames: Record<Format, string> = {
  paper: "종이책",
  logos: "로고스",
  ebook: "전자책",
  pdf: "PDF",
  unknown: "형식 확인 필요",
};
export const orderedFormats = (values: readonly Format[]) =>
  formats.filter((format) => values.includes(format));
export interface ImportedImage {
  sha256: string;
  mime: string;
  bytes: number;
}
export interface ImportSource {
  app: string;
  libraryId: string;
  recordId: string;
  raw: Record<string, unknown>;
  statusCode?: number | null;
  originalFormat?: string;
  cover?: ImportedImage;
  image?: ImportedImage;
  sessions?: {
    sourceId: string;
    statusCode: number | null;
    startedOn: string | null;
    endedOn: string | null;
    bookmarks: {
      sourceId: string;
      page: number | null;
      recordedAt: string | null;
    }[];
    raw: Record<string, unknown>;
  }[];
}
export interface Book {
  id: string;
  title: string;
  author: string;
  publisher: string;
  isbn: string;
  formats: Format[];
  totalPages: number | null;
  shelf: string;
  tags: string[];
  category?: string;
  bookshelves?: string[];
  coverUrl?: string;
  /** Derived from current provider evidence; never replaces the saved cover. */
  catalogCoverUrl?: string;
  storedCoverUrl?: string;
  storedImportedCoverUrl?: string;
  classification?: {
    source?: string;
    code?: string;
    verified?: boolean;
    method?: string;
    url?: string;
  };
  enrichment?: Record<string, unknown>;
  version: number;
  createdAt: string;
  sourceData?: ImportSource | null;
}
export interface ReadingCycle {
  id: string;
  bookId: string;
  status: "reading" | "completed";
  startedOn: string | null;
  completedOn: string | null;
  currentPage: number;
  version: number;
  createdAt: string;
}
export interface Note {
  /** A display preview, never an editable body. */
  summary?: boolean;
  tags?: string[];
  id: string;
  bookId: string | null;
  title: string;
  content: string;
  kind:
    | "thought"
    | "note"
    | "highlight"
    | "review"
    | "claim"
    | "evidence"
    | "counterargument"
    | "reflection";
  page: number | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  sourceData?: ImportSource | null;
}
export interface BookPage {
  items: Book[];
  total: number;
  nextCursor: string | null;
}
export interface Library {
  readingSummary?: {
    totalCompleted: number;
    undatedCount: number;
    completedIds: string[];
    months: Record<
      string,
      { monthCount: number; uniqueBooks: number; rereads: number }
    >;
  };
  catalog?: {
    total: number;
    formatCounts: Record<Format, number>;
    categoryCounts: Record<string, number>;
    firstPage: BookPage;
  };
  shelves?: string[];
  books: Book[];
  cycles: ReadingCycle[];
  notes: Note[];
  deletedNotes?: (Note & { deletedAt: string })[];
  annualMetrics?: {
    year: number;
    reportedBooks: number;
    source: string;
    explanation: string;
  }[];
}
export interface Revision {
  id: string;
  entityId: string;
  action: string;
  before: unknown;
  after: unknown;
  createdAt: string;
}
export interface Command {
  requestId: string;
  editBase?: Record<string, unknown>;
  entityId?: string;
  type: string;
  payload: unknown;
}
export interface MutationResult {
  id: string;
  version: number;
}
export function validDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + "T00:00:00.000Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
export const dateInput = z
  .string()
  .refine(validDate, "올바른 날짜를 입력해 주세요.");
const short = z.string().trim().max(300);
export const bookInput = z.object({
  title: short.min(1, "제목을 입력해 주세요."),
  author: short.default(""),
  publisher: short.default(""),
  isbn: z.string().trim().max(30).default(""),
  formats: z
    .array(z.enum(formats))
    .min(1)
    .transform((v) => [...new Set(v)]),
  totalPages: z.number().int().positive().max(100000).nullable().default(null),
  shelf: z.string().trim().max(300).default(""),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  category: z
    .enum([
      "",
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
    .default(""),
  bookshelves: z
    .array(z.string().trim().min(1).max(80))
    .max(50)
    .transform((v) => [...new Set(v)])
    .default([]),
  coverUrl: z
    .string()
    .max(2000)
    .refine(
      (v) =>
        !v ||
        /^\/api\/book-covers\/[a-f0-9-]{36}$/.test(v) ||
        (() => {
          try {
            const u = new URL(v);
            return (
              u.protocol === "https:" &&
              !u.username &&
              !u.password &&
              !/\s/.test(v)
            );
          } catch {
            return false;
          }
        })(),
      "표지는 https 주소를 사용해 주세요.",
    )
    .default(""),
  catalogSelection: catalogSelection.optional(),
});
export const noteInput = z
  .object({
    ...noteContextFields,
    bookId: z.string().uuid().nullable().default(null),
    title: short.default("").transform((v) => v || "미분류 메모"),
    content: z.string().trim().min(1, "내용을 입력해 주세요.").max(50000),
    kind: z
      .enum([
        "thought",
        "note",
        "highlight",
        "review",
        "claim",
        "evidence",
        "counterargument",
        "reflection",
      ])
      .default("thought"),
    page: z.number().int().positive().nullable().default(null),
    tags: z
      .array(z.string().trim().min(1).max(40))
      .max(20)
      .transform((v) => [...new Set(v)])
      .default([]),
  })
  .refine(
    (v) => v.kind !== "highlight" || (!!v.bookId && !!v.page),
    "하이라이트에는 책과 원문 페이지가 필요합니다.",
  );
export const versionInput = z.object({
  id: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
});
export const commandInput = z.object({
  requestId: z.string().uuid(),
  editBase: z.record(z.string(), z.unknown()).optional(),
  entityId: z.string().uuid().optional(),
  type: z.enum([
    "addBook",
    "editBook",
    "createShelf",
    "startReading",
    "updateProgress",
    "completeReading",
    "editCompletion",
    "addNote",
    "editNote",
    "deleteNote",
    "restoreNote",
    "emptyNoteTrash",
  ]),
  payload: z.unknown(),
});
export function carouselIndex(
  index: number,
  direction: number,
  count: number,
): number {
  return Math.max(0, Math.min(Math.max(0, count - 1), index + direction));
}
export function monthCells(month: string): string[] {
  if (!validDate(month + "-01")) throw new Error("올바른 달을 선택해 주세요.");
  const start = new Date(month + "-01T00:00:00Z");
  start.setUTCDate(1 - start.getUTCDay());
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });
}
export function shiftMonth(month: string, delta: number): string {
  const d = new Date(month + "-01T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + delta);
  return d.toISOString().slice(0, 7);
}
export function todayInSeoul(): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
type StatsCycle = Pick<ReadingCycle, "id" | "bookId" | "completedOn"> & {
  status: string;
};
export function readingStats(cycles: StatsCycle[], month: string) {
  const unique = [...new Map(cycles.map((c) => [c.id, c])).values()];
  const dated = unique
    .filter((c) => c.status === "completed" && c.completedOn)
    .sort((a, b) => a.completedOn!.localeCompare(b.completedOn!));
  const inMonth = dated.filter((c) => c.completedOn!.startsWith(month));
  const seen = new Set<string>();
  let rereads = 0;
  for (const c of dated) {
    if (seen.has(c.bookId) && c.completedOn!.startsWith(month)) rereads++;
    seen.add(c.bookId);
  }
  return {
    monthCount: inMonth.length,
    uniqueBooks: new Set(inMonth.map((c) => c.bookId)).size,
    yearCount: dated.filter((c) => c.completedOn!.startsWith(month.slice(0, 4)))
      .length,
    rereads,
    readingCount: unique.filter((c) => c.status === "reading").length,
    undatedCount: unique.filter(
      (c) => c.status === "completed" && !c.completedOn,
    ).length,
  };
}
export function emptyLibrary(): Library {
  return { books: [], cycles: [], notes: [] };
}
