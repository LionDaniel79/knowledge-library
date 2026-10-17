"use client";
import { libraryRequest } from "@/client/replica/request";
import { useRef, useState } from "react";
import type { BookExclusionPage } from "@/server/book-exclusions";
import { Modal } from "./modal";
import { usePagedResource } from "./use-paged-resource";
import {
  useListPagination,
  PageSizeSelect,
  PageNavigation,
} from "./list-pagination";
export function BookExclusions({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [q, setQ] = useState(""),
    [revision, setRevision] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const pending = useRef<{ key: string; requestId: string } | null>(null);
  const paging = useListPagination("book-exclusions", q);
  const resource = usePagedResource<BookExclusionPage>(
    "/api/book-exclusions?" +
      new URLSearchParams({
        q,
        limit: String(paging.size),
        offset: String(paging.offset),
      }),
    paging.ready,
    revision,
  );
  async function restore(id: string, version: number) {
    if (busy) return;
    const key = id + ":" + version;
    if (pending.current?.key !== key)
      pending.current = { key, requestId: crypto.randomUUID() };
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await libraryRequest("/api/book-exclusions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id,
          expectedVersion: version,
          requestId: pending.current.requestId,
        }),
      });
      const result = await response.json();
      if (!response.ok) {
        if (response.status === 409) setRevision((x) => x + 1);
        throw Error(result.error ?? "복원하지 못했습니다.");
      }
      pending.current = null;
      setRevision((x) => x + 1);
      setMessage("소장 도서로 복원했습니다.");
      try {
        await onChanged();
      } catch {
        setMessage("복원했습니다. 서재를 새로고침하면 목록에 반영됩니다.");
      }
    } catch (error) {
      setError(
        error instanceof TypeError
          ? "연결하지 못했습니다. 다시 복원을 눌러 주세요."
          : error instanceof Error
            ? error.message
            : "복원하지 못했습니다.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="제외한 자료" onClose={onClose} canClose={!busy}>
      <section className="book-exclusions" aria-busy={busy}>
        <label>
          제외한 자료 검색
          <input
            aria-label="제외한 자료 검색"
            type="search"
            maxLength={200}
            placeholder="제목·저자·ISBN"
            value={q}
            disabled={busy}
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
        <p className="form-hint">원본 PDF는 그대로 보관됩니다.</p>
        <PageSizeSelect label="제외한 자료" paging={paging} disabled={busy} />
        {(error || resource.error) && (
          <p role="alert">{error || resource.error}</p>
        )}
        {resource.error && (
          <button className="secondary" onClick={resource.reload}>
            다시 조회
          </button>
        )}
        {message && <p role="status">{message}</p>}
        {resource.loading && <p>목록을 불러오는 중…</p>}
        {resource.data?.items.map((item) => (
          <article key={item.id} className="excluded-material">
            <div>
              <h3>{item.title}</h3>
              <p>
                {item.author || "저자 미입력"} ·{" "}
                {item.kind === "paper" ? "논문" : "간행물"}
              </p>
              <small>{item.relativePath}</small>
            </div>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => void restore(item.id, item.version)}
            >
              복원
            </button>
          </article>
        ))}
        {resource.data?.total === 0 && !resource.loading && (
          <p>조건에 맞는 제외 자료가 없습니다.</p>
        )}
        <PageNavigation
          label="제외한 자료"
          paging={paging}
          total={resource.data?.total ?? 0}
          busy={busy || resource.loading || !!resource.error}
        />
      </section>
    </Modal>
  );
}
