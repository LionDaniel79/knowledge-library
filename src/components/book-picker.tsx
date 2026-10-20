"use client";
import { useState } from "react";
import type { Book, Library } from "@/lib/domain";
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
}: {
  library: Library;
  defaultValue?: string;
  disabled?: boolean;
  required?: boolean;
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
      sort: "title",
      offset: paging.offset,
      limit: paging.size,
    },
    revision: library,
  });
  const local = library.books.filter(
    (b) =>
      !query ||
      [b.title, b.author, b.isbn]
        .join(" ")
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const options = [
    ...new Map(
      [
        ...(selected ? [selected] : []),
        ...(library.catalog
          ? catalog.items
          : local.slice(paging.offset, paging.offset + paging.size)),
      ].map((b) => [b.id, b]),
    ).values(),
  ];
  return (
    <div className="book-picker">
      {!disabled && (
        <label>
          연결할 책 검색
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
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
          <option value="">책과 연결하지 않은 생각</option>
          {options.map((b) => (
            <option key={b.id} value={b.id}>
              {b.title}
              {b.author ? " · " + b.author : ""}
            </option>
          ))}
        </select>
      </label>
      {disabled && <input type="hidden" name="bookId" value={value} />}
      <small className="book-picker-status" role="status">
        {catalog.loading ? "책을 찾고 있습니다…" : "\u00a0"}
      </small>
      {catalog.error && (
        <p role="alert">
          {catalog.error}
          <button type="button" onClick={catalog.reload}>
            다시 조회
          </button>
        </p>
      )}
      {!disabled && (
        <details className="book-picker-pages">
          <summary>
            책 검색 결과 ·{" "}
            {(library.catalog ? catalog.total : local.length).toLocaleString()}
            권
          </summary>
          <PageSizeSelect label="연결할 책" paging={paging} />
          <PageNavigation
            label="연결할 책"
            paging={paging}
            total={library.catalog ? catalog.total : local.length}
            busy={catalog.loading || !!catalog.error}
          />
        </details>
      )}
    </div>
  );
}
