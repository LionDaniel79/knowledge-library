"use client";
import { libraryRequest } from "@/client/replica/request";
import { useState } from "react";
import { Modal } from "./modal";
import type { ImportSummary } from "@/lib/import-package";
export function ImportPanel({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: () => Promise<void>;
}) {
  const [bundle, setBundle] = useState<unknown>();
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [done, setDone] = useState(false);
  async function request(action: string, value: unknown) {
    const response = await libraryRequest("/api/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, bundle: value }),
    });
    const result = await response.json();
    if (!response.ok)
      throw Error(result.error || "자료를 가져오지 못했습니다.");
    return result as ImportSummary;
  }
  return (
    <Modal
      title="기존 독서 자료 가져오기"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <p>
        iReadItNow HD에서 변환한 <b>ireaditnow-library.json</b> 파일을
        선택하세요.
      </p>
      <p className="form-hint">
        원본 ID가 같은 자료는 건너뛰고 기존 편집 내용은 유지합니다. 같은 ISBN의
        다른 항목은 자동으로 합치지 않습니다.
      </p>
      <label className="editor-form">
        가져오기 파일
        <input
          type="file"
          accept=".json,application/json"
          disabled={busy || done}
          onChange={async (event) => {
            setError("");
            setSummary(null);
            setBundle(undefined);
            const file = event.target.files?.[0];
            if (!file) return;
            setBusy(true);
            try {
              if (file.size > 4 * 1024 * 1024)
                throw Error("가져오기 파일은 4MB 이하여야 합니다.");
              const value = JSON.parse(await file.text());
              const result = await request("preview", value);
              setBundle(value);
              setSummary(result);
            } catch (e) {
              setError(e instanceof Error ? e.message : "파일 확인 실패");
            } finally {
              setBusy(false);
            }
          }}
        />
      </label>
      {summary && (
        <div className="notice" role="status">
          <p>
            도서 {summary.totalBooks.toLocaleString()}건 · 기록{" "}
            {summary.totalNotes.toLocaleString()}건
          </p>
          <p>
            {done ? "추가 완료" : "추가 예정"}: 책{" "}
            {summary.addedBooks.toLocaleString()}건 · 기록{" "}
            {summary.addedNotes.toLocaleString()}건
          </p>
          <p>
            이미 가져온 자료: 책 {summary.skippedBooks}건 · 기록{" "}
            {summary.skippedNotes}건
          </p>
          <p>
            ISBN 중복 후보 {summary.duplicateCandidates}건 · 형식 확인 필요{" "}
            {summary.unknownFormats}건
          </p>
          <p>
            옛 독서 이력 {summary.sourceSessions}회는 원본 상태로 보존합니다.
            상태를 확인하기 전에는 완독 통계에 포함하지 않습니다.
          </p>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <footer className="form-footer">
        <button className="secondary" disabled={busy} onClick={onClose}>
          {done ? "닫기" : "취소"}
        </button>
        {!done && (
          <button
            className="primary"
            disabled={busy || !summary}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                setSummary(await request("apply", bundle));
                setDone(true);
                void onImported().catch((e) => setError(e.message));
              } catch (e) {
                setError(e instanceof Error ? e.message : "가져오기 실패");
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "확인 중…" : "내 서재로 가져오기"}
          </button>
        )}
      </footer>
    </Modal>
  );
}
