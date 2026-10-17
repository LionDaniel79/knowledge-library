import { z } from "zod";
export const researchSourceFields = {
  note: ["id", "book_id", "title", "content", "kind", "page", "source_data"],
  book: ["id", "title", "author", "publisher", "isbn"],
} as const;
export function researchSource(note: any, book: any) {
  const fields = (kind: keyof typeof researchSourceFields, value: any) =>
    Object.fromEntries(
      researchSourceFields[kind].map((k) => [k, value[k] ?? null]),
    );
  return {
    note: fields("note", note),
    book: book ? fields("book", book) : null,
  };
}
export const researchSourceSchema = z
  .object({
    note: z
      .record(z.string(), z.unknown())
      .refine(
        (v) =>
          researchSourceFields.note.every((k) => Object.hasOwn(v, k)) &&
          Object.keys(v).length === researchSourceFields.note.length,
      ),
    book: z
      .record(z.string(), z.unknown())
      .refine(
        (v) =>
          researchSourceFields.book.every((k) => Object.hasOwn(v, k)) &&
          Object.keys(v).length === researchSourceFields.book.length,
      )
      .nullable(),
  })
  .strict();
