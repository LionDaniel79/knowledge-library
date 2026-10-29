"use client";
import { RefreshCw } from "lucide-react";
import { useReplicaOptional } from "./provider";
import { syncLabel } from "./sync-status";
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
      title={replica?.status.error || "다른 메뉴를 사용해도 계속 동기화합니다."}
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
  const label = syncLabel(s, r.ready);
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
      {busyPhases.includes(s.phase) &&
        " · 다른 메뉴를 사용해도 계속 동기화합니다."}
      {r.authRequired && (
        <>
          {" "}
          · <a href="/auth/sign-in">로그인</a>
        </>
      )}
    </span>
  );
}
