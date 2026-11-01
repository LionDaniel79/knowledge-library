import { pdfSearchTerms } from "../local/pdf-search-query.mjs";

/** Split plain source text into React-safe pieces without changing the quote. */
export function pdfSearchHighlightParts(text: string, query: string) {
  let terms: string[];
  try {
    terms = pdfSearchTerms(query);
  } catch {
    return [{ text, match: false }];
  }
  const folded = text.toLowerCase();
  const starts: number[] = [],
    ends: number[] = [];
  // Unicode lowercase can expand a character (e.g. İ). Retain the original
  // offsets so highlighting never drops or changes a source character.
  if (folded.length !== text.length) {
    let original = 0;
    for (const character of text) {
      for (let i = 0; i < character.toLowerCase().length; i++) {
        starts.push(original);
        ends.push(original + character.length);
      }
      original += character.length;
    }
  }
  const ranges: [number, number][] = [];
  for (const term of terms) {
    const needle = term.toLowerCase();
    let at = 0;
    while ((at = folded.indexOf(needle, at)) >= 0) {
      ranges.push([
        starts.length ? starts[at] : at,
        ends.length ? ends[at + needle.length - 1] : at + needle.length,
      ]);
      at++;
    }
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range[0] <= previous[1])
      previous[1] = Math.max(previous[1], range[1]);
    else merged.push([...range]);
  }
  const parts: { text: string; match: boolean }[] = [];
  let at = 0;
  for (const [start, end] of merged) {
    if (start > at) parts.push({ text: text.slice(at, start), match: false });
    parts.push({ text: text.slice(start, end), match: true });
    at = end;
  }
  if (at < text.length) parts.push({ text: text.slice(at), match: false });
  return parts;
}
