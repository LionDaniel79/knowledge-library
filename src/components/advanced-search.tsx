"use client";
import { useId, useState } from "react";
import type { Book, Note, Library } from "@/lib/domain";
import { categories, categoryName } from "@/lib/catalog";
import { noteKindNames } from "@/lib/note-kinds";
import { containsSearchField } from "@/lib/search-fields";
import { NoteTagFilter } from "./note-tag-filter";
import { TopicFilter, type FilterTopic } from "./topic-filter";
import { useBookCatalog } from "./use-book-catalog";
import { usePagedResource } from "./use-paged-resource";
import {
  useListPagination,
  PageSizeSelect,
  PageNavigation,
} from "./list-pagination";
export function AdvancedSearch({
  mode,
  library,
  onOpen,
  onUpdated = async () => {},
  preview = false,
}: {
  mode: "book" | "note";
  library: Library;
  onOpen: (kind: string, id: string) => void;
  onUpdated?: () => Promise<void>;
  preview?: boolean;
}) {
  const [submitted, setSubmitted] = useState<Record<string, string> | null>(
      null,
    ),
    [revision, setRevision] = useState(0),
    [topic, setTopic] = useState("all"),
    [tag, setTag] = useState("all"),
    [bookTitle, setBookTitle] = useState("");
  const bookListId = useId();
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
  const topics = usePagedResource<{ topics: FilterTopic[] }>(
    "/api/library-search/topics",
    mode === "note",
    undefined,
    { keepPreviousData: true },
  );
  const books = useBookCatalog({
    enabled: mode === "note" && !!library.catalog && !!bookTitle.trim(),
    query: { title: bookTitle, sort: "title", limit: 30 },
    revision: library.books,
  });
  const titles = [
    ...new Set(
      (library.catalog
        ? books.items
        : library.books.filter((b) => containsSearchField(b.title, bookTitle))
      ).map((b) => b.title),
    ),
  ].slice(0, 30);
  const fields = (
    <>
      <label>
        분야
        <select name="category" aria-label="분야">
          <option value="all">모든 분야</option>
          {categories.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
          {mode === "book" && <option value="unclassified">미분류</option>}
        </select>
      </label>
    </>
  );
  return (
    <section className="advanced-search">
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
          setSubmitted(values);
          paging.setPage(0);
          setRevision((n) => n + 1);
        }}
        onReset={() => {
          setSubmitted(null);
          setTopic("all");
          setTag("all");
          setBookTitle("");
        }}
      >
        {mode === "book" ? (
          <>
            <div className="form-row">
              {[
                ["title", "제목"],
                ["author", "저자"],
                ["publisher", "출판사"],
                ["isbn", "ISBN"],
              ].map(([name, label]) => (
                <label key={name}>
                  {label}
                  <input name={name} maxLength={300} />
                </label>
              ))}
            </div>
            <div className="form-row">
              {fields}
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
            </div>
          </>
        ) : (
          <div className="memo-search-fields">
            <label>
              종류
              <select name="kind" aria-label="종류">
                <option value="all">모든 기록</option>
                <option value="unclassified">미분류 메모</option>
                {Object.entries(noteKindNames).map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            {fields}
            <TopicFilter
              topics={topics.data?.topics ?? []}
              ready={!!topics.data}
              value={topic}
              onChange={setTopic}
              preview={preview}
              onUpdated={async () => {
                topics.reload();
                setRevision((n) => n + 1);
                await onUpdated();
              }}
              onRemoved={(id) =>
                setSubmitted((old) =>
                  old?.topic === id ? { ...old, topic: "all" } : old,
                )
              }
            />
            <input type="hidden" name="topic" value={topic} />
            <>
              <NoteTagFilter
                searchable
                tags={library.notes.flatMap((n) => n.tags ?? [])}
                value={tag}
                onChange={setTag}
                preview={preview}
                onUpdated={async () => {
                  setRevision((n) => n + 1);
                  await onUpdated();
                }}
                onRemoved={(removed) =>
                  setSubmitted((old) =>
                    old?.tag === removed ? { ...old, tag: "all" } : old,
                  )
                }
              />
              <input type="hidden" name="tag" value={tag} />
            </>
            <label>
              제목
              <input
                aria-label="제목"
                name="bookTitle"
                list={bookListId}
                value={bookTitle}
                onChange={(e) => setBookTitle(e.target.value)}
                placeholder="연결된 책 제목"
                maxLength={300}
              />
              <datalist id={bookListId}>
                {titles.map((title) => (
                  <option key={title} value={title}>
                    {title}
                  </option>
                ))}
              </datalist>
            </label>
            <label>
              메모 내용
              <input name="content" aria-label="메모 내용" maxLength={300} />
            </label>
          </div>
        )}
        {(topics.error || books.error) && mode === "note" && (
          <p role="alert">
            {topics.error || books.error}
            <button
              type="button"
              onClick={() => {
                topics.reload();
                books.reload();
              }}
            >
              다시 조회
            </button>
          </p>
        )}
        <div className="form-footer">
          <button type="reset" className="secondary">
            초기화
          </button>
          <button className="primary">검색</button>
        </div>
      </form>
      {result.error && <p role="alert">{result.error}</p>}
      {submitted && (
        <section
          className="advanced-search-results"
          aria-label={mode === "book" ? "도서 검색 결과" : "메모 검색 결과"}
        >
          <p role="status">
            {result.loading ? "찾는 중…" : `${result.data?.total ?? 0}개 결과`}
          </p>
          <PageSizeSelect
            label={mode === "book" ? "도서 검색" : "메모 검색"}
            paging={paging}
          />
          {result.data?.items.map((item) => (
            <article key={item.id}>
              <button
                className="text-button"
                onClick={() => onOpen(mode, item.id)}
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
            label={mode === "book" ? "도서 검색" : "메모 검색"}
            paging={paging}
            total={result.data?.total ?? 0}
            busy={result.loading}
          />
        </section>
      )}
    </section>
  );
}
