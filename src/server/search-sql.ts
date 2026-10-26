import { categories } from "../lib/catalog";

// POSIX space alone omits Unicode spaces accepted by JavaScript \s.
const whitespace =
  "[:space:]\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
const compact = (expression: string, commas = true) =>
  `regexp_replace(lower(coalesce(${expression}::text,'')),'[${whitespace}${commas ? ",，、" : ""}]+','','g')`;

// Callers supply SQL expressions/placeholders only; user text stays in parameters.
// This mirrors containsSearchField, including literal comma-only searches.
export function searchFieldSql(value: string, query: string) {
  return `(CASE WHEN ${compact(query, false)}='' THEN true WHEN ${compact(query)}='' THEN strpos(${compact(value, false)},${compact(query, false)})>0 ELSE NOT EXISTS (
    SELECT 1 FROM regexp_split_to_table(lower(coalesce(${query}::text,'')),'[${whitespace}]+') AS search_word(value)
    WHERE regexp_replace(search_word.value,'[,，、]+','','g')<>''
      AND strpos(${compact(value)},regexp_replace(search_word.value,'[,，、]+','','g'))=0
  ) END)`;
}

export function categorySearchTextSql(value: string) {
  return `(CASE ${value} ${categories.map(([id, name]) => `WHEN '${id}' THEN '${name}'`).join(" ")} ELSE '미분류' END)`;
}
