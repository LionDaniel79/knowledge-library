import { z } from "zod";
export const printedTocSchema = z
  .object({
    method: z.literal("printed_toc_excerpt"),
    documentId: z.string().uuid(),
    signature: z.string().min(1).max(200),
    pageCount: z.number().int().positive(),
    pages: z
      .array(
        z
          .object({
            page: z.number().int().positive(),
            method: z.enum(["text", "ocr_unverified"]),
            textHash: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .min(1)
      .max(4),
    text: z.string().min(1).max(8000),
    editedText: z.string().trim().min(1).max(8000).optional(),
    truncated: z.boolean(),
  })
  .strict()
  .refine(
    (v) =>
      v.pages.every(
        (p, i) => p.page <= v.pageCount && (!i || p.page > v.pages[i - 1].page),
      ),
    "목차 원문 쪽을 확인해 주세요.",
  );
export type PrintedToc = z.infer<typeof printedTocSchema>;
export function editPrintedToc(value: PrintedToc, text: string): PrintedToc {
  return printedTocSchema.parse({ ...value, editedText: text });
}
export function samePrintedTocSource(a: PrintedToc, b: PrintedToc): boolean {
  const { editedText: _a, ...sourceA } = a,
    { editedText: _b, ...sourceB } = b;
  return JSON.stringify(sourceA) === JSON.stringify(sourceB);
}
