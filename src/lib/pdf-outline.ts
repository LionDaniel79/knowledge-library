import { z } from "zod";
export const pdfOutlineSchema = z
  .object({
    documentId: z.string().uuid(),
    signature: z.string().min(1).max(200),
    pageCount: z.number().int().positive(),
    method: z.enum(["embedded_outline", "edited_outline"]),
    entries: z
      .array(
        z
          .object({
            title: z.string().trim().min(1).max(300),
            page: z.number().int().positive().nullable(),
            level: z.number().int().min(0).max(8),
          })
          .strict(),
      )
      .min(1)
      .max(200),
    totalEntries: z.number().int().positive(),
    truncated: z.boolean(),
  })
  .strict()
  .refine(
    (v) => v.entries.every((e) => e.page === null || e.page <= v.pageCount),
    "PDF 쪽수를 확인해 주세요.",
  );
export type PdfOutline = z.infer<typeof pdfOutlineSchema>;
export function formatOutlineDraft(outline: PdfOutline): string {
  return outline.entries
    .map((e) => e.title + (e.page === null ? "" : ` | ${e.page}`))
    .join("\n");
}
export function editOutlineDraft(
  outline: PdfOutline,
  text: string,
): PdfOutline {
  const entries = text
    .split(/\r?\n/)
    .filter((s) => s.trim())
    .map((line) => {
      const split = line.lastIndexOf("|");
      const title = (split < 0 ? line : line.slice(0, split)).trim();
      const pageText = split < 0 ? "" : line.slice(split + 1).trim();
      if (split >= 0 && !/^\d+$/.test(pageText))
        throw Error("쪽수는 숫자로 입력해 주세요. 예: 서론 | 12");
      return { title, page: pageText ? Number(pageText) : null, level: 0 };
    });
  return pdfOutlineSchema.parse({
    ...outline,
    entries,
    method: "edited_outline",
    totalEntries: entries.length,
    truncated: false,
  });
}
