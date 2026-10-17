"use client";
import { useEffect, useState } from "react";
import { useReplicaOptional } from "./provider";
import { Modal } from "../modal";
import {
  readStorageStatus,
  requestPersistentStorage,
  readShellStatus,
  formatStorageBytes,
} from "@/client/replica/device";
import { syncLabel } from "./sync-status";
export function SyncSettings({ onClose }: { onClose: () => void }) {
  const replica = useReplicaOptional(),
    [capacity, setCapacity] = useState<Awaited<
      ReturnType<typeof readStorageStatus>
    > | null>(null),
    [shell, setShell] = useState("확인 중"),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void Promise.all([readStorageStatus(), readShellStatus()]).then(
      ([s, a]) => {
        if (live) {
          setCapacity(s);
          setShell(
            a === "unavailable"
              ? "준비 중"
              : a === "waiting"
                ? "새 버전 대기"
                : "저장됨",
          );
        }
      },
    );
    return () => {
      live = false;
    };
  }, [replica?.revision, replica?.status.phase]);
  const status = replica?.status,
    working =
      busy ||
      (!!status &&
        ["preparing", "downloading", "checking", "pulling", "pushing"].includes(
          status.phase,
        ));
  async function sync(rebuild = false) {
    if (!replica) return;
    setBusy(true);
    setMessage("");
    try {
      await replica.runtime.sync({ reason: "manual", rebuild });
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "다시 시도해 주세요.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="기기 저장·동기화" onClose={onClose}>
      <div className="sync-settings">
        <p role="status">
          {status ? syncLabel(status, !!replica?.ready) : "온라인으로 사용 중"}
        </p>
        <dl>
          <dt>전체 서재 자료</dt>
          <dd>{replica?.ready ? "기기에 저장됨" : "저장 준비 중"}</dd>
          <dt>저장된 자료</dt>
          <dd>
            {(status?.rows ?? 0).toLocaleString("ko-KR")}개 ·{" "}
            {formatStorageBytes(status?.bytes ?? null)}
          </dd>
          <dt>남은 자료</dt>
          <dd>{(status?.remaining ?? 0).toLocaleString("ko-KR")}개</dd>
          <dt>전송 대기 / 확인 필요</dt>
          <dd>
            {status?.pending ?? 0}개 /{" "}
            {(status?.conflicts ?? 0) + (status?.failed ?? 0)}개
          </dd>
          <dt>마지막 동기화</dt>
          <dd>
            {status?.lastSyncedAt
              ? new Date(status.lastSyncedAt).toLocaleString("ko-KR")
              : "아직 없음"}
          </dd>
          <dt>앱 화면 저장</dt>
          <dd>{shell}</dd>
          <dt>브라우저 사용 / 한도</dt>
          <dd>
            {formatStorageBytes(capacity?.usage ?? null)} /{" "}
            {formatStorageBytes(capacity?.quota ?? null)}
          </dd>
          <dt>자료 보관 보호</dt>
          <dd>
            {capacity?.persisted === true
              ? "허용됨"
              : capacity?.persisted === false
                ? "요청 가능"
                : "지원 여부 확인 불가"}
          </dd>
        </dl>
        <div className="sync-setting-actions">
          <button
            type="button"
            className="button secondary"
            disabled={!replica || working}
            onClick={() => void sync()}
          >
            동기화 재개
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={!replica || working}
            onClick={() => void sync(true)}
          >
            전체 다시 받기
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const ok = await requestPersistentStorage();
                setCapacity(await readStorageStatus());
                setMessage(
                  ok === true
                    ? "자료 보관 보호를 허용했습니다."
                    : ok === false
                      ? "브라우저에서 허용하지 않았습니다. 현재 자료는 유지됩니다."
                      : "이 브라우저에서는 보관 보호를 요청할 수 없습니다.",
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            자료 보관 보호 요청
          </button>
        </div>
        <button
          type="button"
          className="button secondary"
          disabled={
            !replica ||
            working ||
            (!!status && status.pending + status.conflicts + status.failed > 0)
          }
          onClick={async () => {
            if (!replica) return;
            setBusy(true);
            try {
              await replica.runtime.clearDownloaded();
              setMessage(
                "이 기기의 내려받은 자료를 지웠습니다. 온라인 조회를 사용하며, 동기화를 누르면 전체를 다시 받습니다.",
              );
            } catch (e) {
              setMessage((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          이 기기의 내려받은 자료 지우기
        </button>
        {(message || status?.error) && (
          <p role="alert">{message || status?.error}</p>
        )}
        <details>
          <summary>사용법</summary>
          <p>
            온라인 서재의 전체 자료와 표지를 이 기기에 저장한 뒤 변경분만
            주고받습니다. 외장하드의 PDF·색인은 포함하지 않습니다. 기기마다 최초
            받기가 필요합니다.
          </p>
          <p>
            ‘기기에 저장됨’은 조회 준비가 끝났다는 뜻입니다. ‘동기화 완료’는
            전송 대기와 확인할 충돌도 없다는 뜻입니다. 앱 화면도 저장되어야
            인터넷 없이 다시 열 수 있습니다.
          </p>
          <p>
            공간이 부족하면 공간을 확보한 뒤 ‘동기화 재개’를 누르세요. 저장한
            조각부터 이어 받습니다. ‘전체 다시 받기’ 중에도 기존 자료와 미전송
            입력은 보관합니다. 미전송 입력이 있으면 기기 자료 지우기를 막습니다.
            온라인 원본과 과거 충돌 원본은 지우지 않습니다.
          </p>
          <p>
            여러 창은 한 창씩 동기화합니다. 보관 보호 허용 여부는 브라우저가
            결정합니다. 브라우저의 사이트 자료를 직접 삭제하면 미전송 입력도
            없어집니다. 먼저 ‘백업과 복원’에서 기기 자료를 내려받으세요.
          </p>
        </details>
      </div>
    </Modal>
  );
}
