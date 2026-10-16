"use client";
import { useState } from "react";
export function McpConnections() {
  const [data, setData] = useState<any>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function load() {
    const r = await fetch("/api/mcp-connections", { cache: "no-store" }),
      j = await r.json();
    if (!r.ok) throw Error(j.error ?? "연결 설정을 확인해 주세요.");
    setData(j);
  }
  async function revoke(id: string) {
    setBusy(true);
    try {
      const r = await fetch("/api/mcp-connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!r.ok) throw Error("연결을 해제하지 못했습니다.");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details
      onToggle={(e) => {
        if (e.target === e.currentTarget && e.currentTarget.open && !data)
          void load().catch((e) => setError(e.message));
      }}
    >
      <summary>ChatGPT 연결</summary>
      {error && <p role="status">{error}</p>}
      {data && (
        <>
          <p>읽기 전용 연결 주소</p>
          <input
            aria-label="ChatGPT 연결 주소"
            readOnly
            value={data.endpoint}
          />
          <details>
            <summary>사용법</summary>
            <p>
              ChatGPT의 앱·연결 설정에서 사용자 지정 MCP 연결을 만들고 위 주소와
              OAuth 방식을 선택하세요. Google 로그인 후 읽기를 허용합니다. 해당
              설정의 제공 여부는 ChatGPT 계정에 따라 다릅니다.
            </p>
          </details>
          {!data.connections.length && <p>연결된 ChatGPT가 없습니다.</p>}
          {data.connections.map((c: any) => (
            <p key={c.id}>
              ChatGPT · 만료 {String(c.expires_at).slice(0, 10)}{" "}
              <button disabled={busy} onClick={() => void revoke(c.id)}>
                연결 해제
              </button>
            </p>
          ))}
        </>
      )}
    </details>
  );
}
