import { z } from "zod";
import { bookInput, dateInput } from "./domain";
const sourceId = z.string().min(1).max(200);
const raw = z.record(z.string(), z.unknown());
const image = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  mime: z.enum(["image/jpeg", "image/png"]),
  bytes: z.number().int().positive(),
});
export const sourceDataInput = z.object({
  app: z.literal("iReadItNow HD"),
  libraryId: sourceId,
  recordId: sourceId,
  raw,
  statusCode: z.number().int().nullable().optional(),
  originalFormat: z.string().optional(),
  cover: image.nullable().optional(),
  image: image.optional(),
  sessions: z
    .array(
      z.object({
        sourceId,
        statusCode: z.number().int().nullable(),
        startedOn: dateInput.nullable(),
        endedOn: dateInput.nullable(),
        bookmarks: z.array(
          z.object({
            sourceId,
            page: z.number().int().nullable(),
            recordedAt: z.iso.datetime().nullable(),
          }),
        ),
        raw,
      }),
    )
    .optional(),
  lists: z.array(raw).optional(),
});
export const importPackageInput = z
  .object({
    schemaVersion: z.literal(1),
    source: z.literal("iReadItNowHD"),
    sourceLibraryId: sourceId,
    databaseSha256: z.string().regex(/^[a-f0-9]{64}$/),
    timezone: z.literal("Asia/Seoul"),
    books: z
      .array(
        bookInput.extend({
          sourceId,
          sourceData: sourceDataInput,
          sourceCreatedAt: z.iso.datetime().nullable(),
        }),
      )
      .min(1)
      .max(20000),
    notes: z
      .array(
        z.object({
          sourceId,
          bookSourceId: sourceId,
          title: z.string().min(1).max(300),
          content: z.string().min(1).max(50000),
          kind: z.enum(["note", "review"]),
          page: z.number().int().positive().nullable(),
          sourceCreatedAt: z.iso.datetime().nullable(),
          sourceData: sourceDataInput,
        }),
      )
      .max(100000),
    originalTables: z.record(z.string(), z.array(raw)),
  })
  .superRefine((data, ctx) => {
    const books = new Set(data.books.map((b) => b.sourceId));
    if (
      books.size !== data.books.length ||
      new Set(data.notes.map((n) => n.sourceId)).size !== data.notes.length
    )
      ctx.addIssue({
        code: "custom",
        message: "중복된 원본 식별자가 있습니다.",
      });
    if (data.notes.some((n) => !books.has(n.bookSourceId)))
      ctx.addIssue({
        code: "custom",
        message: "연결할 책이 없는 기록이 있습니다.",
      });
    if (
      [...data.books, ...data.notes].some(
        (r) => r.sourceData.libraryId !== data.sourceLibraryId,
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "원본 서재 식별자가 일치하지 않습니다.",
      });
  });
export type ImportPackage = z.infer<typeof importPackageInput>;
export interface ImportSummary {
  totalBooks: number;
  totalNotes: number;
  addedBooks: number;
  addedNotes: number;
  skippedBooks: number;
  skippedNotes: number;
  duplicateCandidates: number;
  unknownFormats: number;
  sourceSessions: number;
}
