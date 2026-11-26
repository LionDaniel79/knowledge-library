import {
  currentBookInformation,
  mergeBookInformation,
  type AutomaticInformation,
  type CurrentBookInformation,
} from "./unified-book-information";
import { formatOutlineDraft, pdfOutlineSchema } from "./pdf-outline";
import { printedTocSchema } from "./printed-toc";

export const bookInformationFields = [
  ["description", "책 소개"],
  ["toc", "목차"],
  ["publicationYear", "발행연도"],
  ["referenceIsbn", "참고 판본 ISBN"],
] as const;
export type BookInformationField = (typeof bookInformationFields)[number][0];

export function displayedBookInformation(
  enrichment: Record<string, unknown> = {},
  items: Parameters<typeof mergeBookInformation>[0] = [],
  current: CurrentBookInformation = currentBookInformation(enrichment),
) {
  const rows = mergeBookInformation(
    items,
    enrichment.autoBibliography as AutomaticInformation | undefined,
    enrichment.informationSelections as Parameters<
      typeof mergeBookInformation
    >[2],
    current,
  );
  const edited = new Set(
    enrichment.bookInformationEdits as BookInformationField[] | undefined,
  );
  const selected = enrichment.catalogSelection as
    { description?: string } | undefined;
  const result: Partial<Record<BookInformationField, unknown>> = {};
  for (const [field] of bookInformationFields) {
    const value = edited.has(field)
      ? enrichment["auto_" + field]
      : (rows.find((row) => row.field === field)?.values[0]?.value ??
        (field === "description" ? selected?.description : undefined));
    if (
      value != null &&
      value !== "" &&
      (!Array.isArray(value) || value.length)
    )
      result[field] = value;
  }
  return result;
}

export function bookInformationText(value: unknown) {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value))
    return value.filter((row) => typeof row === "string").join("\n");
  const printed = printedTocSchema.safeParse(value);
  if (printed.success) return printed.data.editedText ?? printed.data.text;
  const outline = pdfOutlineSchema.safeParse(value);
  return outline.success ? formatOutlineDraft(outline.data) : "";
}
