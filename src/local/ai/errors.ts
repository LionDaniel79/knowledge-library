export class LocalModelUnavailableError extends Error {
  constructor() {
    super("로컬 AI 모델을 사용할 수 없습니다. 실행 상태를 확인해 주세요.");
    this.name = "LocalModelUnavailableError";
  }
}
