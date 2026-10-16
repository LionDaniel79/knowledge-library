"use client";
import { useState } from "react";
export function McpConsent({
  parameters,
}: {
  parameters: Record<string, string>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function decide(approve: boolean) {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/mcp/authorize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parameters, approve }),
        }),
        j = await r.json();
      if (!r.ok) throw Error(j.error ?? "연결을 확인해 주세요.");
      window.location.assign(j.redirect);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <main className="auth-page">
      <section className="auth-card">
        <h1>ChatGPT에 서재 연결</h1>
        <p>
          ChatGPT에서 도서 목록과 내 기록을 검색하고 읽을 수 있도록 허용합니다.
          조회한 내용은 ChatGPT 대화에 전달될 수 있습니다.
        </p>
        <p>
          권한: 도서·기록 읽기. 연결은 서재의 AI 설정에서 해제할 수 있습니다.
        </p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button
            disabled={busy}
            className="primary"
            onClick={() => void decide(true)}
          >
            읽기 연결 허용
          </button>
          <button disabled={busy} onClick={() => void decide(false)}>
            취소
          </button>
        </div>
      </section>
    </main>
  );
}
