"use client";
import { libraryRequest } from "@/client/replica/request";
import { useState } from "react";
export function DeviceSettings() {
  const [devices, setDevices] = useState<
      {
        id: string;
        name: string;
        revokedAt: string | null;
        expiresAt: string;
      }[]
    >([]),
    [token, setToken] = useState(""),
    [ownerId, setOwnerId] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function refresh() {
    const r = await libraryRequest("/api/thought-devices", {
      cache: "no-store",
    });
    if (!r.ok) throw Error("PC 목록을 불러오지 못했습니다.");
    setDevices(await r.json());
  }
  async function act(body: object) {
    setBusy(true);
    setError("");
    try {
      const r = await libraryRequest("/api/thought-devices", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
        data = await r.json();
      if (!r.ok) throw Error(data.error ?? "연결을 저장하지 못했습니다.");
      if (data.token) {
        setToken(data.token);
        setOwnerId(data.ownerId);
      }
      void refresh().catch((e) => setError(e.message));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details
      className="panel"
      onToggle={(e) => {
        if (e.currentTarget.open)
          void refresh().catch((e) => setError(e.message));
      }}
    >
      <summary>API 요청을 전달할 PC 연결</summary>
      <p>새 PC를 연결할 때만 키를 만드세요.</p>
      <button
        disabled={busy}
        onClick={() => void act({ op: "issue", name: "내 API 연결 PC" })}
      >
        PC 연결 키 만들기
      </button>
      {token && (
        <div>
          <label>
            한 번만 표시되는 PC 연결 키<input readOnly value={token} />
          </label>
          <p>이 키는 PC의 개인 설정 파일에만 보관하세요.</p>
          <button
            onClick={() => {
              void navigator.clipboard
                .writeText(token)
                .catch(() => setError("키를 직접 선택하여 복사해 주세요."));
            }}
          >
            연결 키 복사
          </button>
          <button
            onClick={() => {
              const url = URL.createObjectURL(
                new Blob(
                  [
                    JSON.stringify(
                      { origin: location.origin, ownerId, token },
                      null,
                      2,
                    ),
                  ],
                  { type: "application/json" },
                ),
              );
              const a = document.createElement("a");
              a.href = url;
              a.download = "knowledge-library-worker.private.json";
              a.click();
              URL.revokeObjectURL(url);
            }}
          >
            PC 연결 파일 저장
          </button>
          <button onClick={() => setToken("")}>키 숨기기</button>
        </div>
      )}
      {devices.map((d) => (
        <p key={d.id}>
          {d.name} ·{" "}
          {d.revokedAt ? "연결 해제됨" : `만료 ${d.expiresAt.slice(0, 10)}`}{" "}
          {!d.revokedAt && (
            <button
              disabled={busy}
              onClick={() => void act({ op: "revoke", id: d.id })}
            >
              연결 해제
            </button>
          )}
        </p>
      ))}
      {error && <p role="status">{error}</p>}
    </details>
  );
}
