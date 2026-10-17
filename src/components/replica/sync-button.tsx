"use client";
import { RefreshCw } from "lucide-react";
import { useReplicaOptional } from "./provider";
const busyPhases = [
  "preparing",
  "downloading",
  "checking",
  "pulling",
  "pushing",
];
export function SyncButton({ onError }: { onError: (error: Error) => void }) {
  const replica = useReplicaOptional(),
    busy = !!replica && busyPhases.includes(replica.status.phase);
  return (
    <button
      type="button"
      className="secondary sync-button"
      aria-label="동기화"
      aria-busy={busy}
      disabled={!replica || busy}
      title={replica?.status.error || "변경된 자료를 동기화합니다."}
      onClick={() => {
        if (replica)
          void replica.runtime
            .sync({ reason: "manual" })
            .catch((e) =>
              onError(e instanceof Error ? e : Error("동기화하지 못했습니다.")),
            );
      }}
    >
      <RefreshCw size={17} />
      {busy ? "동기화 중" : "동기화"}
    </button>
  );
}
export function SyncSummary() {
  const r = useReplicaOptional();
  if (!r) return null;
  const s = r.status;
  const label =
    s.phase === "complete"
      ? s.pending
        ? `${s.pending}개 전송 대기`
        : "동기화 완료"
      : s.phase === "downloading"
        ? `${s.rows.toLocaleString("ko-KR")}개 받는 중`
        : s.phase === "checking"
          ? "검증 중"
          : s.phase === "offline"
            ? "오프라인"
            : s.phase === "error"
              ? "동기화 실패"
              : busyPhases.includes(s.phase)
                ? "동기화 중"
                : r.ready
                  ? "기기에 저장됨"
                  : "기기 자료 준비";
  return (
    <span
      className="sync-summary"
      role="status"
      title={
        s.error ||
        (s.lastSyncedAt ? new Date(s.lastSyncedAt).toLocaleString("ko-KR") : "")
      }
    >
      {label}
      {r.authRequired && (
        <>
          {" "}
          · <a href="/auth/sign-in">로그인</a>
        </>
      )}
    </span>
  );
}
