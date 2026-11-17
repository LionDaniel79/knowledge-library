export const retryDelays = [60000, 300000, 900000];
export function failureGuidance(failure = {}) {
  const kind = failure.kind;
  const messages = {
    authentication: [
      "인증 또는 DB 접근 권한 오류",
      "웹 연결 설정의 인증키와 계정을 확인하세요. DB 권한 오류는 프로그램 업데이트 또는 관리자 확인이 필요합니다.",
    ],
    quota: [
      "제공자 API 호출 한도 도달",
      "호출 가능 시각 이후 다시 시도하세요. 호출 원장을 삭제하거나 한도를 우회하지 마세요.",
    ],
    storage: [
      "저장 공간 부족",
      "PC 및 웹 표지 저장 공간을 확보한 뒤 다시 시도하세요. PDF와 색인은 삭제하지 마세요.",
    ],
    "database-timeout": [
      "DB 연결 시간 초과",
      "인터넷 연결을 확인하세요. 안전한 읽기 단계이면 제한 횟수 내에서 자동 재시도합니다.",
    ],
    network: [
      "외부 서버 연결 오류",
      "인터넷 연결을 확인하세요. 안전한 조회 단계이면 제한 횟수 내에서 자동 재시도합니다.",
    ],
    "state-file": [
      "진행 기록 파일 저장 충돌",
      "잠시 기다린 뒤 다시 시도하세요. 반복되면 보안 프로그램 또는 저장 장치 상태를 확인하세요.",
    ],
    configuration: [
      "수집 실행 설정 오류",
      "웹 연결 설정과 프로그램 설치 파일을 확인하세요. 인증키를 로그나 대화에 붙여넣지 마세요.",
    ],
    unexpected: [
      "프로그램 처리 오류",
      "프로그램을 최신 버전으로 업데이트하세요. 반복되면 아래 오류 종류·단계·코드를 전달해 주세요. 진행 기록은 보존됩니다.",
    ],
  };
  const [summary, action] = messages[kind] ?? messages.unexpected;
  return { summary, action };
}
export function automaticRetry(halt, previous = {}, now = Date.now()) {
  const failure = halt?.failure ?? {};
  if (
    !["network", "database-timeout"].includes(failure.kind) ||
    failure.retryable !== true ||
    failure.safeToRetry !== true
  )
    return { allowed: false, ...failureGuidance(failure) };
  if (
    previous.count !== undefined &&
    (!Number.isSafeInteger(previous.count) || previous.count < 0)
  )
    return { allowed: false, ...failureGuidance({ kind: "configuration" }) };
  const count = previous.count ?? 0;
  if (count >= retryDelays.length)
    return {
      allowed: false,
      exhausted: true,
      count,
      ...failureGuidance(failure),
    };
  const at = Date.parse(halt.at);
  if (!Number.isFinite(at))
    return { allowed: false, ...failureGuidance(failure) };
  const nextAt = new Date(at + retryDelays[count]).toISOString();
  return {
    allowed: true,
    due: now >= Date.parse(nextAt),
    count,
    nextAt,
    ...failureGuidance(failure),
  };
}
