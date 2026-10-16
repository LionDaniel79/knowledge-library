import type { LocalAiConfig } from "../../lib/thought-map/types";
export async function readModelConfig(_path?: string): Promise<LocalAiConfig> {
  throw Error("로컬 AI 설정은 종료되었습니다. 요청형 API 설정을 사용하세요.");
}
export async function recordInstalledModels(
  _path: string,
  _tag?: string,
): Promise<LocalAiConfig> {
  throw Error(
    "로컬 AI 모델 등록은 종료되었습니다. 모델을 내려받거나 실행하지 않습니다.",
  );
}
