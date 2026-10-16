import { pdfOutlineSchema, type PdfOutline } from "../../lib/pdf-outline";
export interface OutlineDocument {
  id: string;
  signature: string;
  pageCount: number;
  processingScope: string;
  status: string;
}
export function buildPdfOutline(
  document: OutlineDocument,
  raw: unknown,
): PdfOutline | null {
  if (
    document.processingScope !== "full" ||
    !["ready", "partial_ocr", "ocr_review", "needs_ocr"].includes(
      document.status,
    ) ||
    !Array.isArray(raw) ||
    !Number.isSafeInteger(document.pageCount) ||
    document.pageCount < 1
  )
    return null;
  const entries: PdfOutline["entries"] = [],
    seen = new Set<string>();
  for (const item of raw.slice(0, 1000)) {
    if (!item || typeof item.title !== "string") continue;
    const title = item.title.replace(/\s+/g, " ").trim();
    if (!title || title.length > 300) continue;
    if (/^\d+(?:_\d+)+(?:\.(?:jpe?g|png|tiff?|bmp))?$/i.test(title)) continue;
    if (
      /^(?:IMG|DSC|SCAN)[ _-]*\d+(?:[_-]\w+)*(?:\.(?:jpe?g|png|tiff?|bmp))?$/i.test(
        title,
      )
    )
      continue;
    if (
      /^(?:무제|untitled|bookmark)\s*\d*$/i.test(title) ||
      /^\d{4}[-/.]\d{2}[-/.]\d{2}(?:[\d\s:._-]*)$/.test(title) ||
      /^[\p{P}\p{S}\s]+\d+$/u.test(title) ||
      /^(.)\1{1,}$/u.test(title)
    )
      continue;
    if (
      /^(?:(?:page|p|페이지|scan)\s*)?\d+(?:\.(?:jpe?g|png|tiff?|bmp))?$/i.test(
        title,
      )
    )
      continue;
    const entry = {
      title,
      page:
        Number.isInteger(item.page) &&
        item.page >= 1 &&
        item.page <= document.pageCount
          ? (item.page as number)
          : null,
      level:
        Number.isInteger(item.level) && item.level >= 0 && item.level <= 8
          ? (item.level as number)
          : 0,
    };
    const key = JSON.stringify(entry);
    if (!seen.has(key)) {
      seen.add(key);
      entries.push(entry);
    }
  }
  if (!entries.length) return null;
  const parsed = pdfOutlineSchema.safeParse({
    documentId: document.id,
    signature: document.signature,
    pageCount: document.pageCount,
    method: "embedded_outline",
    entries: entries.slice(0, 200),
    totalEntries: entries.length,
    truncated: entries.length > 200 || raw.length > 1000,
  });
  return parsed.success ? parsed.data : null;
}
