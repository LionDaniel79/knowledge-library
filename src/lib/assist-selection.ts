import type { TopicMaterial } from "./topic-materials";
export function representativeNotes(
  rows: TopicMaterial[],
  limit = 24,
  priorityId?: string,
) {
  const buckets = new Map<string, TopicMaterial[]>();
  for (const row of rows) {
    const key =
      (row.topicIds[0] || row.category || "unclassified") +
      ":" +
      (row.bookId || "unlinked");
    const bucket = buckets.get(key) ?? [];
    bucket.push(row);
    buckets.set(key, bucket);
  }
  const chosen: TopicMaterial[] = [],
    used = new Set<string>();
  const add = (row: TopicMaterial | undefined) => {
    if (row && !used.has(row.id) && chosen.length < limit) {
      chosen.push(row);
      used.add(row.id);
    }
  };
  add(rows.find((n) => n.id === priorityId));
  for (let round = 0; chosen.length < limit && round < rows.length; round++)
    for (const bucket of buckets.values()) {
      const i =
        round % 2 === 0
          ? Math.floor(round / 2)
          : bucket.length - 1 - Math.floor(round / 2);
      add(i >= 0 ? bucket[i] : undefined);
    }
  return chosen;
}
export function analysisExcerpt(text: string, query: string, limit: number) {
  if (text.length <= limit) return undefined;
  const needle = query.trim().toLocaleLowerCase(),
    match = needle ? text.toLocaleLowerCase().indexOf(needle) : -1;
  let start = Math.max(0, match - 120);
  const paragraph = text.lastIndexOf("\n", start);
  if (paragraph >= 0 && start - paragraph < 100) start = paragraph + 1;
  // Never split a UTF-16 surrogate pair at an excerpt boundary.
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start])) start--;
  let end = Math.min(text.length, start + limit);
  if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end])) end--;
  return { start, end };
}
