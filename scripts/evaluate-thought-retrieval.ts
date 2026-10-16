import { readFile, writeFile } from "node:fs/promises";
// Labels are human-reviewed query/result IDs; generated relevance labels are never accepted as truth.
const data = JSON.parse(
  await readFile("private-data/ai-trial/retrieval-review.json", "utf8"),
);
const reviewed = data.queries.filter(
  (q: any) => q.reviewed === true && Array.isArray(q.relevantIds),
);
const reports = Object.fromEntries(
  ["lexical", "vector", "three_route"].map((mode) => {
    let precision = 0,
      recall = 0,
      crossTotal = 0,
      crossFound = 0;
    for (const q of reviewed) {
      const relevant = new Set(q.relevantIds),
        hits: string[] = q.results[mode] ?? [];
      precision +=
        hits.slice(0, 5).filter((id) => relevant.has(id)).length /
        Math.max(1, Math.min(5, hits.length));
      recall +=
        hits.slice(0, 20).filter((id) => relevant.has(id)).length /
        Math.max(1, relevant.size);
      const cross: string[] = q.crossFieldRelevantIds ?? [];
      crossTotal += cross.length;
      crossFound += cross.filter((id) => hits.slice(0, 20).includes(id)).length;
    }
    return [
      mode,
      {
        reviewedCount: reviewed.length,
        precisionAt5: reviewed.length ? precision / reviewed.length : null,
        recallAt20: reviewed.length ? recall / reviewed.length : null,
        crossFieldRecall: crossTotal ? crossFound / crossTotal : null,
      },
    ];
  }),
);
await writeFile(
  "private-data/ai-trial/retrieval-report.json",
  JSON.stringify(reports, null, 2),
);
console.log("검수한 동일 검색 자료의 평가 결과를 로컬에 저장했습니다.");
