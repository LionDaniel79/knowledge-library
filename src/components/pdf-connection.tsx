"use client";
import { useState } from "react";
export function PdfConnection() {
  const [state, setState] = useState<any>(null),
    [root, setRoot] = useState(""),
    [preview, setPreview] = useState<any>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState(false);
  async function load() {
    try {
      const r = await fetch("/api/pdf/connection", { cache: "no-store" }),
        j = await r.json();
      if (!r.ok) throw Error(j.error);
      setState(j);
      setRoot(j.root ?? "");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function submit(apply: boolean) {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/pdf/connection", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            root,
            action: apply ? "apply" : "preview",
            digest: preview?.digest,
            expectedVersion: preview?.version,
          }),
        }),
        j = await r.json();
      if (!r.ok) throw Error(j.error);
      if (apply) {
        setSaved(true);
        setPreview(null);
        await load();
      } else setPreview(j);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details
      onToggle={(e) => {
        if (e.currentTarget.open && !state) void load();
      }}
    >
      <summary>PDF 폴더 다시 연결</summary>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {state?.available ? (
        <>
          <label>
            외장하드의 PDF 폴더
            <input
              value={root}
              placeholder="E:\전자도서관"
              onChange={(e) => {
                setRoot(e.target.value);
                setPreview(null);
                setSaved(false);
              }}
            />
          </label>
          <button disabled={busy || !root} onClick={() => void submit(false)}>
            연결 검사
          </button>
          {preview && (
            <>
              <p>
                연결 후보 {preview.found}개 · 미연결 {preview.missing}개 · 원본
                대조 {preview.checked}개
              </p>
              <p>각 PDF를 열 때 원본 일치 여부를 추가 확인합니다.</p>
              <button disabled={busy} onClick={() => void submit(true)}>
                이 폴더로 연결
              </button>
            </>
          )}
          {saved && <p role="status">연결을 저장했습니다.</p>}
        </>
      ) : (
        state && <p>내 PC의 서재에서 폴더를 연결해 주세요.</p>
      )}
    </details>
  );
}
