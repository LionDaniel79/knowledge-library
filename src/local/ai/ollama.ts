import type { LocalAi, LocalAiConfig } from "../../lib/thought-map/types";
// Compatibility guard for old scripts: never load a model or fall back to paid inference.
export function createLocalAi(
  _config: LocalAiConfig,
  _fetch: typeof fetch = fetch,
): LocalAi {
  throw Error(
    "로컬 AI 실행은 종료되었습니다. 필요한 자료만 선택해 API 도움을 요청하세요.",
  );
}
