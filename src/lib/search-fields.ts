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
export const containsSearchField = (value: string | undefined, query: string) =>
  !query || compactSearchText(value ?? "").includes(compactSearchText(query));
export const compactBookTitleSearch = (value: string) =>
  compactSearchText(value).replace(/[,，、]/g, "");
export const containsBookTitleSearch = (
  value: string | undefined,
  query: string,
) => {
  const compact = compactBookTitleSearch(query);
  return (
    containsSearchField(value, query) ||
    (!!compact && compactBookTitleSearch(value ?? "").includes(compact))
  );
};
