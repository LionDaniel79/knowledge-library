import { z } from "zod";
const field = z.string().trim().max(300).default("");
export const bookSearchFields = {
  title: field,
  author: field,
  publisher: field,
  isbn: field,
};
export const memoSearchFields = {
  title: field,
  content: field,
  bookTitle: field,
};
export const compactSearchText = (value: string) =>
  value.toLowerCase().replace(/[\s　 ]+/g, "");
export const compactBookTitleSearch = (value: string) =>
  compactSearchText(value).replace(/[,，、]/g, "");
export function searchWords(query: string): string[] {
  const words = query
    .trim()
    .split(/[\s　 ]+/u)
    .map(compactBookTitleSearch)
    .filter(Boolean);
  return words.length
    ? [...new Set(words)]
    : [compactSearchText(query)].filter(Boolean);
}
export const containsSearchField = (
  value: string | undefined,
  query: string,
) => {
  const words = searchWords(query);
  if (!words.length) return true;
  const literal = compactSearchText(value ?? ""),
    compact = literal.replace(/[,，、]/g, "");
  return words.every(
    (word) => compact.includes(word) || literal.includes(word),
  );
};
export const containsBookTitleSearch = containsSearchField;
