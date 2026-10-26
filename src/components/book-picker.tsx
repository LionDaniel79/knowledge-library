"use client";
import { useEffect, useRef, useState } from "react";
import type { Book, Library } from "@/lib/domain";
import { containsSearchField } from "@/lib/search-fields";
import {
  useListPagination,
  PageSizeSelect,
  PageNavigation,
} from "./list-pagination";
import { useBookCatalog } from "./use-book-catalog";
export function BookPicker({
  library,
  defaultValue = "",
  disabled = false,
  required = false,
  excludeId,
  autoSelectFirst = false,
  expandedResults = false,
  onSelect,
}: {
  library: Library;
  defaultValue?: string;
  disabled?: boolean;
  required?: boolean;
  excludeId?: string;
  autoSelectFirst?: boolean;
  expandedResults?: boolean;
  onSelect?: (book: Book | null) => void;
}) {
  const [query, setQuery] = useState(""),
    [value, setValue] = useState(defaultValue),
    [selected, setSelected] = useState<Book | undefined>(() =>
      library.books.find((b) => b.id === defaultValue),
    );
  const paging = useListPagination("book-picker", query);
  const catalog = useBookCatalog({
    enabled: !!library.catalog && !disabled && paging.ready,
    query: {
      q: query,
      exclude: excludeId,
      sort: "title",
      offset: paging.offset,
      limit: paging.size,
    },
    revision: library,
  });
  const local = library.books.filter(
    (b) =>
      b.id !== excludeId &&
      containsSearchField(
        [b.title, b.author, b.publisher, b.isbn].join(" "),
        query,
      ),
  );
  const options = [
    ...new Map(
      [
        ...(!autoSelectFirst && selected ? [selected] : []),
        ...(library.catalog
          ? catalog.items
          : local.slice(paging.offset, paging.offset + paging.size)),
      ].map((b) => [b.id, b]),
    ).values(),
  ];
  const selectionStamp = useRef("");
  const ready = !library.catalog || (!catalog.loading && !catalog.error);
  const next =
    options.find((b) => b.id === value) ??
    (autoSelectFirst ? options[0] : undefined);
  useEffect(() => {
    if (!autoSelectFirst || !ready || disabled) return;
    const stamp = JSON.stringify([
      query,
      paging.offset,
      next?.id,
      next?.version,
    ]);
    if (selectionStamp.current === stamp) return;
    selectionStamp.current = stamp;
    setValue(next?.id ?? "");
    setSelected(next);
    onSelect?.(next ?? null);
  }, [autoSelectFirst, ready, disabled, query, paging.offset, next, onSelect]);
  const pages = (
    <>
      <PageSizeSelect label="연결할 책" paging={paging} />
      <PageNavigation
        label="연결할 책"
        paging={paging}
        total={library.catalog ? catalog.total : local.length}
        busy={catalog.loading || !!catalog.error}
      />
    </>
  );
  return (
    <div className="book-picker">
      {!disabled && (
        <label>
          연결할 책 검색
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (autoSelectFirst) {
                setValue("");
                setSelected(undefined);
                onSelect?.(null);
              }
            }}
            placeholder="제목·저자·ISBN으로 전체 서재 검색"
          />
        </label>
      )}
      <label>
        연결할 책
        <select
          name="bookId"
          required={required}
          disabled={disabled}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setSelected(options.find((b) => b.id === e.target.value));
          }}
        >
          {!autoSelectFirst && (
            <option value="">책과 연결하지 않은 생각</option>
          )}
          {autoSelectFirst && !options.length && (
            <option value="">
              {catalog.loading ? "책을 찾는 중…" : "검색 결과 없음"}
            </option>
          )}
          {options.map((b) => (
            <option key={b.id} value={b.id}>
              {b.title}
              {b.author ? " · " + b.author : ""}
            </option>
          ))}
        </select>
      </label>
      {disabled && <input type="hidden" name="bookId" value={value} />}
      {catalog.loading && (
        <small className="book-picker-status" role="status">
          책을 찾고 있습니다…
        </small>
      )}
      {catalog.error && (
        <p role="alert">
          {catalog.error}
          <button type="button" onClick={catalog.reload}>
            다시 조회
          </button>
        </p>
      )}
      {!disabled &&
        (expandedResults ? (
          <div className="book-picker-pages">
            <p>
              책 검색 결과 ·{" "}
              {(library.catalog
                ? catalog.total
                : local.length
              ).toLocaleString()}
              권
            </p>
            {pages}
          </div>
        ) : (
          <details className="book-picker-pages">
            <summary>
              책 검색 결과 ·{" "}
              {(library.catalog
                ? catalog.total
                : local.length
              ).toLocaleString()}
              권
            </summary>
            {pages}
          </details>
        ))}
    </div>
  );
}
