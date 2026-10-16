import type { PdfSummary, PdfWorkerStatus } from "../lib/pdf-progress";

const n = (value = 0) => value.toLocaleString();
function workerLabel(worker?: PdfWorkerStatus) {
  if (worker?.reason === "low_disk" && worker.status === "paused")
    return "저장 공간 부족으로 중단";
  const names = {
    running: "처리 중",
    paused: "일시 중단",
    completed: "이번 작업 종료",
    failed: "중단 · 확인 필요",
    stale: "최근 응답 없음",
    unknown: "실행 상태 확인 안 됨",
  };
  return names[worker?.status ?? "unknown"];
}
export function PdfProgress({ summary: s }: { summary: PdfSummary }) {
  const known = s.knownPages ?? s.pages;
  const methods = s.pageMethods;
  const searchable = methods
    ? (methods.text ?? 0) + (methods.ocr_unverified ?? 0)
    : s.textPages;
  const percent =
    known > 0 ? Math.min(100, (searchable / known) * 100).toFixed(1) : "0";
  const total = s.total ?? Object.values(s.states).reduce((a, b) => a + b, 0);
  return (
    <div className="notice pdf-progress">
      <strong>
        등록된 PDF {n(total)}개 · 본문 검색 준비 {percent}%
      </strong>
      <p>
        확인된 {n(known)}쪽 중 {n(searchable)}쪽 검색 가능
      </p>
      <progress
        aria-label="PDF 본문 검색 준비"
        max={Math.max(1, known)}
        value={searchable}
      />
      <p>문자 인식: {workerLabel(s.workers?.ocr)}</p>
      <details>
        <summary>자세한 처리 현황</summary>
        {methods && <p>원본 문자 {n(methods.text)}쪽</p>}
        {methods ? (
          <>
            <p>문자 인식 · 원문 대조 전 {n(methods.ocr_unverified)}쪽</p>
            <p>
              빈 인식 결과 {n(methods.ocr_empty)}쪽 · 인식 오류{" "}
              {n(methods.ocr_error)}쪽 · 대기 {n(methods.needs_ocr)}쪽
            </p>
          </>
        ) : (
          <p>페이지별 집계 준비가 필요합니다.</p>
        )}
        <p>
          기본정보만 보관 {n(s.basicOnly)}개 · 파일 확인 필요{" "}
          {n(
            (s.states.error ?? 0) +
              (s.states.locked ?? 0) +
              (s.states.changed ?? 0) +
              (s.states.missing ?? 0),
          )}
          개
        </p>
        {(s.unavailablePages ?? 0) > 0 && (
          <p>변경·오류로 검색에서 제외된 페이지 {n(s.unavailablePages)}쪽</p>
        )}
        {s.hashes && (
          <p>
            중복 확인용 파일 지문 {n(s.hashes.stored)} / {n(s.hashes.total)}개
            저장
          </p>
        )}
        <p>중복 확인 준비: {workerLabel(s.workers?.hash)}</p>
        <p className="form-hint">
          문자 인식 결과는 인용하기 전에 원문과 대조하세요. 빈 결과도 빈
          페이지로 확정한 것은 아닙니다. 파일 지문만으로 같은 판본을 확정하지
          않습니다.
        </p>
      </details>
    </div>
  );
}
