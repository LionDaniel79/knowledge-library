import type { SyncStatus } from "@/lib/replica/contracts";
export function syncLabel(s: SyncStatus, ready: boolean) {
  if (s.phase === "error") return "동기화 실패";
  if (s.phase === "offline") return "오프라인";
  if (s.phase === "downloading")
    return `${s.rows.toLocaleString("ko-KR")}개 받는 중`;
  if (s.phase === "checking") return "검증 중";
  if (s.phase === "pushing" && s.upload) {
    const { processed, total } = s.upload;
    return processed < total
      ? `기록 ${processed}/${total}개 처리 · ${total - processed}개 남음`
      : `기록 ${total}/${total}개 처리 · 반영 확인 중`;
  }
  if (["preparing", "pulling", "pushing"].includes(s.phase)) return "동기화 중";
  if (s.conflicts || s.failed) return `${s.conflicts + s.failed}개 확인 필요`;
  if (s.pending) return `${s.pending}개 전송 대기`;
  return s.phase === "complete" && ready
    ? "동기화 완료"
    : ready
      ? "기기에 저장됨"
      : "기기 자료 준비";
}
