"use client";

import { useRef, useState } from "react";
import type { Book } from "@/lib/domain";
import { libraryRequest } from "@/client/replica/request";
import { Modal } from "./modal";

export function BookDelete({
  book,
  disabled,
  onDeleted,
  onConflict,
}: {
  book: Book;
  disabled?: boolean;
  onDeleted: (queued: boolean) => void;
  onConflict: () => void;
}) {
  const [confirmation, setConfirmation] = useState<Pick<
      Book,
      "id" | "title" | "version"
    > | null>(null),
    [busy, setBusy] = useState(false),
    [stale, setStale] = useState(false),
    [error, setError] = useState("");
  const pending = useRef<string | null>(null),
    submitting = useRef(false);
  async function remove() {
    if (!confirmation || submitting.current || stale) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    pending.current ??= crypto.randomUUID();
    try {
      const response = await libraryRequest("/api/book-exclusions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "delete",
            id: confirmation.id,
            expectedVersion: confirmation.version,
            requestId: pending.current,
          }),
        }),
        result = await response.json();
      if (!response.ok) {
        if (response.status === 409) {
          setStale(true);
          onConflict();
        }
        throw Error(result.error ?? "도서를 삭제하지 못했습니다.");
      }
      pending.current = null;
      setConfirmation(null);
      onDeleted(result.queued === true);
    } catch (cause) {
      setError(
        cause instanceof TypeError
          ? "연결하지 못했습니다. 도서 삭제를 다시 눌러 주세요."
          : cause instanceof Error
            ? cause.message
            : "도서를 삭제하지 못했습니다.",
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <button
        type="button"
        className="secondary"
        disabled={disabled}
        onClick={() => {
          setConfirmation({
            id: book.id,
            title: book.title,
            version: book.version,
          });
          pending.current = null;
          setError("");
          setStale(false);
        }}
      >
        삭제
      </button>
      {confirmation && (
        <Modal
          title="소장 도서 삭제"
          onClose={() => setConfirmation(null)}
          canClose={!busy}
        >
          <p>
            <strong>{confirmation.title}</strong> 도서를 소장 도서에서
            삭제할까요?
          </p>
          <p>
            원본 PDF와 메모·독서 이력은 보관됩니다. 소장 도서의 ‘삭제·제외한
            자료’에서 복원할 수 있습니다.
          </p>
          {error && <p role="alert">{error}</p>}
          {stale && <p>취소한 뒤 책 정보를 다시 열어 확인해 주세요.</p>}
          <div className="detail-actions">
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => setConfirmation(null)}
            >
              취소
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy || stale}
              onClick={() => void remove()}
            >
              {busy ? "삭제 중…" : "도서 삭제"}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
