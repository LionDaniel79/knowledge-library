"use client";
import { useEffect, useState } from "react";
import { Modal } from "./modal";
import { pcPdfFolderUrl, privatePcOrigin } from "@/lib/pc-access";
import { PdfBulkImport } from "./pdf-bulk-import";
export function PdfConnection({
  onImported,
}: { onImported?: () => Promise<void> } = {}) {
  const [state, setState] = useState<any>(null),
    [root, setRoot] = useState(""),
    [preview, setPreview] = useState<any>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState(false),
    [open, setOpen] = useState(false);
  useEffect(() => {
    if (new URLSearchParams(location.search).get("panel") === "folder") {
      setOpen(true);
      void load();
    }
  }, []);
  async function load() {
    try {
      const r = await fetch("/api/pdf/connection", { cache: "no-store" }),
        j = await r.json();
      if (!r.ok) throw Error(j.error);
      const origin = privatePcOrigin(j.pcOrigin);
      if (!j.available && origin && origin !== location.origin) {
        location.assign(pcPdfFolderUrl(origin));
        return;
      }
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
    <div className="pdf-folder-settings">
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          if (!state) void load();
        }}
      >
        PDF 보관 폴더 설정
      </button>
      {open && (
        <Modal
          title="PDF 보관 폴더 설정"
          onClose={() => setOpen(false)}
          canClose={!busy}
        >
          {!state && !error && <p>연결 설정을 읽는 중입니다…</p>}
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
              <PdfBulkImport
                root={root}
                disabled={busy || !root}
                onImported={onImported}
                connection={
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy || !root}
                    onClick={() => void submit(false)}
                  >
                    연결 검사
                  </button>
                }
              />
              {preview && (
                <>
                  <p>
                    찾은 PDF {preview.found}개 · 찾지 못한 PDF {preview.missing}
                    개 · 원본 대조 {preview.checked}개
                  </p>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => void submit(true)}
                  >
                    이 위치로 저장
                  </button>
                </>
              )}
              {saved && <p role="status">연결을 저장했습니다.</p>}
            </>
          ) : (
            state && (
              <p>
                PC의 PDF 보관 폴더 설정을 열 수 없습니다. PC 서재 연결을 확인해
                주세요.
              </p>
            )
          )}
        </Modal>
      )}
    </div>
  );
}
