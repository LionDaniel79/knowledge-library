"use client";
import { useEffect, useState } from "react";
import { pageSize, pageSizes, pageWindow } from "@/lib/list-pagination";

export function useListPagination(scope: string, resetKey = "") {
  const storageKey = `library:page-size:${scope}`;
  const [size, setSize] = useState(30);
  const [ready, setReady] = useState(false);
  const [position, setPosition] = useState({ key: resetKey, page: 0 });
  // Commit a changed filter so returning to an earlier filter cannot revive its page.
  if (position.key !== resetKey) setPosition({ key: resetKey, page: 0 });
  useEffect(() => {
    try {
      setSize(pageSize(localStorage.getItem(storageKey)));
    } catch {}
    setReady(true);
  }, [storageKey]);
  const page = position.key === resetKey ? position.page : 0;
  function setPage(value: number) {
    setPosition({ key: resetKey, page: Math.max(0, value) });
  }
  function chooseSize(value: number) {
    const next = pageSize(value);
    setSize(next);
    setPage(0);
    try {
      localStorage.setItem(storageKey, String(next));
    } catch {}
  }
  return { page, size, offset: page * size, ready, setPage, chooseSize };
}
export type ListPaging = ReturnType<typeof useListPagination>;

export function PageSizeSelect({
  label,
  paging,
  disabled = false,
}: {
  label: string;
  paging: ListPaging;
  disabled?: boolean;
}) {
  return (
    <label className="page-size-select">
      <span>표시 개수</span>
      <select
        aria-label={`${label} 표시 개수`}
        value={paging.size}
        disabled={disabled || !paging.ready}
        onChange={(e) => paging.chooseSize(Number(e.target.value))}
      >
        {pageSizes.map((n) => (
          <option key={n} value={n}>
            {n}개
          </option>
        ))}
      </select>
    </label>
  );
}

export function PageNavigation({
  label,
  paging,
  total,
  busy = false,
}: {
  label: string;
  paging: ListPaging;
  total: number;
  busy?: boolean;
}) {
  const window = pageWindow(total, paging.size, paging.page);
  useEffect(() => {
    if (!busy && paging.ready && window.page !== paging.page)
      paging.setPage(window.page);
  }, [busy, paging.ready, paging.page, window.page]);
  const first = Math.max(0, Math.min(window.pages - 5, window.page - 2));
  return (
    <nav className="list-pagination" aria-label={`${label} 페이지`}>
      <span className="page-range" aria-live="polite">
        {window.start}–{window.end} / {total.toLocaleString()}개
      </span>
      <div className="page-buttons">
        <button
          type="button"
          disabled={busy || window.page === 0}
          onClick={() => paging.setPage(0)}
          aria-label="첫 페이지"
        >
          «
        </button>
        <button
          type="button"
          disabled={busy || window.page === 0}
          onClick={() => paging.setPage(window.page - 1)}
        >
          이전
        </button>
        {Array.from(
          { length: Math.min(5, window.pages) },
          (_, i) => first + i,
        ).map((p) => (
          <button
            type="button"
            key={p}
            disabled={busy}
            aria-label={`${p + 1}페이지`}
            aria-current={p === window.page ? "page" : undefined}
            onClick={() => paging.setPage(p)}
          >
            {p + 1}
          </button>
        ))}
        <span className="page-count">/ {window.pages}</span>
        <button
          type="button"
          disabled={busy || window.page + 1 >= window.pages}
          onClick={() => paging.setPage(window.page + 1)}
        >
          다음
        </button>
        <button
          type="button"
          disabled={busy || window.page + 1 >= window.pages}
          onClick={() => paging.setPage(window.pages - 1)}
          aria-label="마지막 페이지"
        >
          »
        </button>
      </div>
    </nav>
  );
}
