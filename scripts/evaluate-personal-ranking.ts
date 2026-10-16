import { readFile, writeFile, mkdir } from "node:fs/promises";
import { trainRanker } from "../src/local/thought-map/ranking";
await mkdir("private-data/thought-ai", { recursive: true });
const data = JSON.parse(
  await readFile("private-data/thought-ai/ranking-review.json", "utf8"),
);
const report = trainRanker(data.rows, data.split);
await writeFile(
  "private-data/thought-ai/ranking-report.json",
  JSON.stringify(report, null, 2),
);
console.log(
  `학습 표본 ${report.trainingCount}개, 독립 평가 표본 ${report.holdoutCount}개. ${report.promoted ? "사용자 검토 가능" : "기존 순위 유지"}. 자동 적용하지 않습니다.`,
);
