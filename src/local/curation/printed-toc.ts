import { createHash } from "node:crypto";
import { printedTocSchema, type PrintedToc } from "../../lib/printed-toc";
import type { OutlineDocument } from "./pdf-outline";
export interface PrintedTocPage {
  pageNumber: number;
  text: string;
  method: string;
}
const heading =
  /^(?:목\s*차|차\s*례|table\s+of\s+contents|contents)\s*[:：.]?$/i;
function contentsSignals(text: string) {
  const lines = text
    .split(/\r?\n/)
    .map((x) => x.normalize("NFKC").trim())
    .filter(Boolean);
  const marker = lines.slice(0, 20).some((x) => heading.test(x));
  const numbers = lines.filter(
    (x) =>
      x.length <= 300 &&
      /[\p{L}]/u.test(x) &&
      (/\s(?:\d{1,4}|[ivxlcdm]{1,8})(?:\s*[,，]\s*\d{1,4})*\s*$/i.test(x) ||
        /^(?:\d{1,4}|[ivxlcdm]{1,8})\s+\p{L}/iu.test(x)),
  ).length;
  const referenceHeading = lines
    .slice(0, 5)
    .some((x) => /^(?:참고\s*문헌|references|bibliography)$/i.test(x));
  return {
    marker,
    dense:
      !referenceHeading &&
      numbers >= 3 &&
      numbers / Math.max(1, lines.length) >= (marker ? 0.15 : 0.35),
  };
}
/** Source excerpts only: printed chapter numbers are never converted to PDF offsets. */
export function buildPrintedToc(
  document: OutlineDocument,
  input: PrintedTocPage[],
): PrintedToc | null {
  if (
    document.processingScope !== "full" ||
    !["ready", "partial_ocr", "ocr_review", "needs_ocr"].includes(
      document.status,
    ) ||
    !Number.isSafeInteger(document.pageCount) ||
    document.pageCount < 1
  )
    return null;
  const seen = new Set<number>();
  const pages = input
    .filter(
      (p) =>
        Number.isInteger(p.pageNumber) &&
        p.pageNumber >= 1 &&
        p.pageNumber <= document.pageCount &&
        (p.pageNumber <= 40 || p.pageNumber > document.pageCount - 10) &&
        ["text", "ocr_unverified"].includes(p.method) &&
        typeof p.text === "string" &&
        p.text.trim() &&
        !seen.has(p.pageNumber) &&
        !!seen.add(p.pageNumber),
    )
    .sort((a, b) => a.pageNumber - b.pageNumber);
  const start = pages.findIndex((p) => {
    const s = contentsSignals(p.text);
    return s.marker && s.dense;
  });
  if (start < 0) return null;
  const selected: PrintedToc["pages"] = [];
  let text = "",
    truncated = false;
  for (let i = start; i < pages.length; i++) {
    const p = pages[i];
    if (
      i > start &&
      (p.pageNumber !== pages[i - 1].pageNumber + 1 ||
        !contentsSignals(p.text).dense)
    )
      break;
    if (selected.length >= 4) {
      truncated = true;
      break;
    }
    const separator = text ? "\n\n" : "",
      room = 8000 - text.length - separator.length;
    if (room <= 0) {
      truncated = true;
      break;
    }
    text += separator + p.text.slice(0, room);
    selected.push({
      page: p.pageNumber,
      method: p.method as "text" | "ocr_unverified",
      textHash: createHash("sha256").update(p.text).digest("hex"),
    });
    if (p.text.length > room) {
      truncated = true;
      break;
    }
  }
  const result = printedTocSchema.safeParse({
    method: "printed_toc_excerpt",
    documentId: document.id,
    signature: document.signature,
    pageCount: document.pageCount,
    pages: selected,
    text,
    truncated,
  });
  return result.success ? result.data : null;
}
