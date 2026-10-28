import type { TopicMaterial } from "./topic-materials";
export const MAX_ANALYSIS_NOTES = 1000;
export async function collectAnalysisNotes(
  read: (offset: number) => Promise<{ total: number; items: TopicMaterial[] }>,
  all: boolean,
) {
  const candidates: TopicMaterial[] = [],
    used = new Set<string>();
  let total = 0;
  for (let offset = 0; all || offset < 200; offset += 50) {
    const page = await read(offset);
    if (offset && total !== page.total)
      throw Error("검색 결과가 변경됐습니다. 다시 검색해 주세요.");
    total = page.total;
    if (all && total > MAX_ANALYSIS_NOTES)
      throw Error(
        `전체 ${total}개는 한 번에 분석할 수 없습니다. 주제·태그로 ${MAX_ANALYSIS_NOTES}개 이하로 좁혀 주세요.`,
      );
    for (const row of page.items)
      if (!used.has(row.id)) {
        used.add(row.id);
        candidates.push(row);
      }
    if (candidates.length >= total) break;
    if (!page.items.length || page.items.length < 50) {
      if (all) throw Error("검색 결과가 변경됐습니다. 다시 검색해 주세요.");
      break;
    }
  }
  return { candidates, total };
}
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
