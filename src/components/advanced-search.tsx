"use client";
import { useState } from "react";
import type { Book, Note } from "@/lib/domain";
import { categories, categoryName } from "@/lib/catalog";
import { Modal } from "./modal";
import { usePagedResource } from "./use-paged-resource";
import {
  useListPagination,
  PageSizeSelect,
  PageNavigation,
} from "./list-pagination";
const kinds = {
  unclassified: "미분류 메모",
  thought: "나의 생각",
  note: "독서 메모",
  highlight: "하이라이트",
  review: "서평",
  claim: "주장",
  evidence: "근거",
  counterargument: "반론",
  reflection: "생각의 변화",
};
export function AdvancedSearch({
  mode,
  onClose,
  onOpen,
}: {
  mode: "book" | "note";
  onClose: () => void;
  onOpen: (kind: string, id: string) => void;
}) {
  const [submitted, setSubmitted] = useState<Record<string, string> | null>(
    null,
  );
  const [revision, setRevision] = useState(0);
  const paging = useListPagination(
    "advanced-" + mode,
    JSON.stringify(submitted),
  );
  const result = usePagedResource<{ items: (Book | Note)[]; total: number }>(
    (mode === "book" ? "/api/books?" : "/api/notes?") +
      new URLSearchParams({
        ...submitted,
        offset: String(paging.offset),
        limit: String(paging.size),
      }),
    !!submitted && paging.ready,
    revision,
  );
  const fields =
    mode === "book"
      ? [
          ["title", "제목"],
          ["author", "저자"],
          ["publisher", "출판사"],
          ["isbn", "ISBN"],
        ]
      : [
          ["title", "제목"],
          ["content", "메모 내용"],
          ["bookTitle", "연결된 책 제목"],
          ["tag", "태그"],
        ];
  return (
    <Modal
      title={mode === "book" ? "도서 상세 검색" : "메모 상세 검색"}
      onClose={onClose}
    >
      <form
        className="advanced-search-form"
        onSubmit={(e) => {
          e.preventDefault();
          const values = Object.fromEntries(
            [...new FormData(e.currentTarget)].map(([key, value]) => [
              key,
              String(value).trim(),
            ]),
          );
          if (mode === "note" && !values.tag) values.tag = "all";
          setSubmitted(values);
          paging.setPage(0);
          setRevision((n) => n + 1);
        }}
      >
        <div className="form-row">
          {fields.map(([name, label]) => (
            <label key={name}>
              {label}
              <input
                name={name}
                maxLength={name === "tag" ? 80 : 300}
                autoFocus={name === "title"}
              />
            </label>
          ))}
        </div>
        <div className="form-row">
          <label>
            분야
            <select name="category">
              <option value="all">모든 분야</option>
              {categories.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
              {mode === "book" && <option value="unclassified">미분류</option>}
            </select>
          </label>
          {mode === "book" ? (
            <label>
              소장·독서 상태
              <select name="filter">
                <option value="all">전체</option>
                <option value="reading">읽는 중</option>
                <option value="completed">완독</option>
                <option value="paper">종이책</option>
                <option value="ebook">전자책</option>
                <option value="pdf">PDF</option>
              </select>
            </label>
          ) : (
            <label>
              종류
              <select name="kind">
                <option value="all">모든 기록</option>
                {Object.entries(kinds).map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <small className="form-hint">
          입력한 조건을 모두 만족하는 자료를 찾습니다.
        </small>
        <div className="form-footer">
          <button
            type="reset"
            className="secondary"
            onClick={() => setSubmitted(null)}
          >
            초기화
          </button>
          <button className="primary">검색</button>
        </div>
      </form>
      {result.error && <p role="alert">{result.error}</p>}
      {submitted && (
        <section
          className="advanced-search-results"
          aria-label="상세 검색 결과"
        >
          <p role="status">
            {result.loading ? "찾는 중…" : `${result.data?.total ?? 0}개 결과`}
          </p>
          <PageSizeSelect label="상세 검색" paging={paging} />
          {result.data?.items.map((item) => (
            <article key={item.id}>
              <button
                className="text-button"
                onClick={() => {
                  onClose();
                  onOpen(mode, item.id);
                }}
              >
                <strong>{item.title}</strong>
              </button>
              {"author" in item ? (
                <p>
                  {item.author} · {item.publisher}
                  <br />
                  {item.isbn || "ISBN 미입력"} ·{" "}
                  {categoryName(item.category ?? "")}
                </p>
              ) : (
                <p>{item.content}</p>
              )}
            </article>
          ))}
          <PageNavigation
            label="상세 검색"
            paging={paging}
            total={result.data?.total ?? 0}
            busy={result.loading}
          />
        </section>
      )}
    </Modal>
  );
}
