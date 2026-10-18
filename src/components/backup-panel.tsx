"use client";
import {
  libraryRequest,
  downloadDeviceArchive,
} from "@/client/replica/request";
import { useReplicaOptional } from "./replica/provider";
import { useState } from "react";
import { Modal } from "./modal";
import { BACKUP_FILE_MAX } from "../lib/backup-limits";
type Preview = {
  canRestore: boolean;
  existingRecords: number;
  createdAt: string;
  counts: Record<string, number>;
};
const names: Record<string, string> = {
  library_books: "도서",
  library_notes: "기록",
  library_cycles: "독서 이력",
  library_revisions: "수정 이력",
  library_topics: "주제",
  library_connections: "자료 연결",
  library_book_relations: "소장본·판본 연결",
  library_research_placements: "연구 자료 배치·해석",
  library_external_links: "과거 외부 연결",
  library_cover_assets: "업로드한 표지",
  library_research: "설교·논문 모음",
  library_curation_items: "정리 정보",
};
export function BackupPanel({
  onClose,
  onRestored,
}: {
  onClose: () => void;
  onRestored: () => Promise<void>;
}) {
  const replica = useReplicaOptional();
  const [file, setFile] = useState<File | null>(null),
    [backup, setBackup] = useState<unknown>(null),
    [preview, setPreview] = useState<Preview | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  async function send(action: "preview" | "restore", value: unknown) {
    const response = await libraryRequest("/api/backup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, backup: value }),
    });
    if (response.status === 413)
      throw Error(
        "백업이 서버 업로드 한도를 초과합니다. PC에서 복원해 주세요.",
      );
    const result = await response.json();
    if (!response.ok)
      throw Error(result.error ?? "백업을 처리하지 못했습니다.");
    return result;
  }
  async function inspect() {
    if (!file) return;
    setBusy(true);
    setError("");
    setMessage("");
    setPreview(null);
    setBackup(null);
    try {
      if (file.size > BACKUP_FILE_MAX)
        throw Error("백업은 511MB 이하로 선택하세요.");
      let value: unknown;
      try {
        value = JSON.parse(await file.text());
      } catch {
        throw Error("백업 JSON을 읽을 수 없습니다.");
      }
      const result = await send("preview", value);
      setBackup(value);
      setPreview(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "백업 검사 실패");
    } finally {
      setBusy(false);
    }
  }
  async function restore() {
    if (!preview?.canRestore || !backup) return;
    setBusy(true);
    setError("");
    try {
      await send("restore", backup);
      setPreview(null);
      setBackup(null);
      setMessage("복원을 마쳤습니다.");
      void onRestored().catch(() => {
        setError("복원은 완료됐습니다. 화면을 새로고침해 주세요.");
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "복원 실패");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      canClose={!busy}
      title="백업과 복원"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="backup-panel">
        <p>
          도서, 독서 기록, 내 생각, 사유 연결과 수정 이력을 하나의 파일로
          보관합니다.
        </p>
        <a className="button primary" href="/api/backup">
          복원용 백업 내려받기
        </a>
        {replica?.ready && (
          <button
            className="button secondary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await downloadDeviceArchive();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            기기 전체 자료 내려받기
          </button>
        )}
        {replica?.ready && (
          <p className="muted">
            전체 자료 파일에는 표지·과거 기록·송신 대기가 포함됩니다. 복원은
            위의 복원용 백업을 사용하세요.
          </p>
        )}
        <p className="muted">
          PDF 원본·색인·가져온 표지 파일은 별도로 보관해 주세요.
          로그인·인증키·자동 실행 작업은 포함하지 않습니다.
        </p>
        <hr />
        <label>
          복원할 백업 파일
          <input
            type="file"
            accept=".json,application/json"
            disabled={busy}
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setPreview(null);
              setBackup(null);
              setError("");
              setMessage("");
            }}
          />
        </label>
        <button
          type="button"
          className="button secondary"
          disabled={!file || busy}
          onClick={inspect}
        >
          {busy ? "처리 중…" : "백업 검사"}
        </button>
        {preview && (
          <section aria-label="백업 검사 결과">
            <p>
              백업 시각: {new Date(preview.createdAt).toLocaleString("ko-KR")}
            </p>
            <ul>
              {Object.entries(names).map(([key, label]) => (
                <li key={key}>
                  {label} {(preview.counts[key] ?? 0).toLocaleString("ko-KR")}건
                </li>
              ))}
            </ul>
            <p>
              {preview.canRestore
                ? "빈 서재에 복원할 수 있습니다."
                : "기존 자료가 있어 복원할 수 없습니다. 빈 서재에서 복원하세요."}
            </p>
            <button
              className="button primary"
              disabled={!preview.canRestore || busy}
              onClick={restore}
            >
              빈 서재에 복원
            </button>
          </section>
        )}
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        {message && <p role="status">{message}</p>}
      </div>
    </Modal>
  );
}
