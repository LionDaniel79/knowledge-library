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
      title={replica?.status.error || (busy ? "동기화 중" : "동기화")}
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
  const busy = busyPhases.includes(s.phase);
  const label = busy ? "" : syncLabel(s, r.ready);
  return (
    <span
      className="sync-summary"
      role="status"
      aria-hidden={busy}
      title={
        s.error ||
        (s.lastSyncedAt ? new Date(s.lastSyncedAt).toLocaleString("ko-KR") : "")
      }
    >
      {label}
      {!busy && r.authRequired && (
        <>
          {" "}
          · <a href="/auth/sign-in">로그인</a>
        </>
      )}
    </span>
  );
}
