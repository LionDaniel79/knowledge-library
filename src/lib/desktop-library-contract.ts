import { z } from "zod";

const text = (maximum: number) =>
  z
    .string()
    .max(maximum)
    .refine(
      (s) => !/[\u0000-\u001f\u007f-\u009f]/.test(s),
      "제어문자는 사용할 수 없습니다.",
    )
    .trim();
const uuid = z
  .string()
  .uuid()
  .transform((s) => s.toLowerCase());
const relativePath = text(1024)
  .min(1)
  .transform((s) => s.replaceAll("\\", "/"))
  .refine(
    (s) =>
      !s.startsWith("/") &&
      !/[:%<>"|?*]/.test(s) &&
      s
        .split("/")
        .every(
          (part) =>
            part !== "" &&
            part !== "." &&
            part !== ".." &&
            part.trim() === part &&
            !part.endsWith(".") &&
            !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part),
        ),
    "승인된 보관함 안의 안전한 상대경로만 사용할 수 있습니다.",
  );
export const desktopLibraryLocation = z
  .object({
    rootKey: z.enum(["christian", "general"]),
    relativePath,
  })
  .strict();
export const desktopLibraryItem = z
  .object({
    resourceId: uuid,
    legacyDocumentId: uuid.optional(),
    bookId: uuid.optional(),
    expectedBookVersion: z.number().int().positive().max(2147483647).optional(),
    metadata: z
      .object({
        title: text(300).min(1),
        author: text(300).optional(),
        publisher: text(300).optional(),
        isbn: text(32).optional(),
        totalPages: z.number().int().positive().max(1000000).optional(),
      })
      .strict(),
    locations: z
      .array(desktopLibraryLocation)
      .min(1)
      .max(32)
      .transform((rows) =>
        rows.sort(
          (a, b) =>
            a.rootKey.localeCompare(b.rootKey) ||
            a.relativePath.localeCompare(b.relativePath),
        ),
      )
      .refine(
        (rows) =>
          new Set(rows.map((r) => JSON.stringify(r))).size === rows.length,
        "위치가 중복되었습니다.",
      ),
  })
  .strict();
export const desktopLibraryBatch = z
  .object({
    requestId: uuid,
    action: z.literal("upsert"),
    items: z.array(desktopLibraryItem).min(1).max(100),
  })
  .strict()
  .refine(
    (p) => new Set(p.items.map((r) => r.resourceId)).size === p.items.length,
    "자료 ID가 중복되었습니다.",
  );
export type DesktopLibraryItem = z.infer<typeof desktopLibraryItem>;
export type DesktopLibraryResult = {
  requestId: string;
  items: {
    resourceId: string;
    bookId: string | null;
    documentId: string | null;
    bookVersion: number | null;
    state: "registered" | "unchanged" | "excluded" | "conflict";
  }[];
};
