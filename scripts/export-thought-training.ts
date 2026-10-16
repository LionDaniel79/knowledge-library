import { mkdir, writeFile } from "node:fs/promises";
import {
  openLocalDatabase,
  loadOwnerSources,
} from "../src/local/thought-map/database-transport";
if (!process.argv.includes("--consent"))
  throw Error("학습 예시 내보내기는 --consent로 명시적으로 요청해야 합니다.");
const local = await openLocalDatabase();
try {
  const state = await loadOwnerSources(local.db, local.owner),
    revoked = new Set(
      state.feedback.flatMap((f) => (f.revokesId ? [f.revokesId] : [])),
    );
  const rows = state.feedback
    .filter(
      (f) => f.decision === "accept" && !revoked.has(f.id) && f.correctedOutput,
    )
    .flatMap((f) => {
      const c = state.candidates.find((c) => c.id === f.candidateId);
      if (
        !c ||
        c.outdated ||
        c.before.voice !== "self" ||
        c.after.voice !== "self"
      )
        return [];
      const changed =
        JSON.stringify(f.originalOutput) !== JSON.stringify(f.correctedOutput);
      return [
        {
          type: changed ? "reviewed_preference" : "reviewed_example",
          before: c.before,
          after: c.after,
          preferred: f.correctedOutput,
          ...(changed ? { rejected: f.originalOutput } : {}),
        },
      ];
    });
  await mkdir("private-data/thought-ai", { recursive: true });
  await writeFile(
    `private-data/thought-ai/reviewed-examples-${Date.now()}.jsonl`,
    rows.map((r) => JSON.stringify(r)).join("\n"),
  );
  console.log(
    `${rows.length}개 검수 예시를 로컬에 저장했습니다. 모델 학습이나 외부 전송은 실행하지 않았습니다.`,
  );
} finally {
  await local.close();
}
