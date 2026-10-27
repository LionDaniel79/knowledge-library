"use client";
import { useMemo } from "react";
import type { Library, ReadingCycle } from "@/lib/domain";
import { BookCover } from "./book-cover";
import {
  PageNavigation,
  PageSizeSelect,
  useListPagination,
} from "./list-pagination";
import { usePagedResource } from "./use-paged-resource";

export function MonthCompletedBooks({
  library,
  month,
  onOpenBook,
}: {
  library: Library;
  month: string;
  onOpenBook: (id: string) => void;
}) {
  const remote = !!library.readingSummary;
  const paging = useListPagination("stats-month-books", month);
  const resource = usePagedResource<{
    items: ReadingCycle[];
    books: Library["books"];
    total: number;
  }>(
    `/api/reading?completedMonth=${month}&limit=${paging.size}&offset=${paging.offset}`,
    remote && paging.ready,
    library,
  );
  const local = useMemo(
    () =>
      library.cycles
        .filter(
          (c) =>
            c.status === "completed" && c.completedOn?.startsWith(month + "-"),
        )
        .sort(
          (a, b) =>
            a.completedOn!.localeCompare(b.completedOn!) ||
            a.id.localeCompare(b.id),
        ),
    [library.cycles, month],
  );
  const page = remote && !resource.loading ? resource.data : null;
  const cycles = remote
    ? (page?.items ?? [])
    : local.slice(paging.offset, paging.offset + paging.size);
  const total = remote
    ? (page?.total ?? library.readingSummary?.months[month]?.monthCount ?? 0)
    : local.length;
  const books = new Map(
    (remote ? (page?.books ?? []) : library.books).map((b) => [b.id, b]),
  );
  return (
    <section
      className="month-completed-books"
      aria-label={`${Number(month.slice(5))}월 완독 도서`}
    >
      <h3>
        {Number(month.slice(5))}월 완독 · {total}권
      </h3>
      {remote && resource.loading ? (
        <p role="status">완독한 책을 불러오는 중…</p>
      ) : resource.error ? (
        <p role="alert">
          {resource.error} <button onClick={resource.reload}>다시 조회</button>
        </p>
      ) : cycles.length ? (
        <div className="month-cover-list">
          {cycles.map((c) => {
            const book = books.get(c.bookId);
            return book ? (
              <button
                key={c.id}
                type="button"
                data-cycle-id={c.id}
                aria-label={`${book.title} · ${c.completedOn} 완독`}
                onClick={() => onOpenBook(book.id)}
              >
                <BookCover book={book} />
                <strong>{book.title}</strong>
                <time dateTime={c.completedOn!}>
                  {c.completedOn!.slice(5).replace("-", ".")}
                </time>
              </button>
            ) : null;
          })}
        </div>
      ) : (
        <p className="muted">이달의 완독 기록이 없습니다.</p>
      )}
      {(total > 10 || paging.page > 0) && (
        <div className="month-cover-paging">
          <PageNavigation
            label="월별 완독 도서"
            paging={paging}
            total={total}
            busy={remote && (resource.loading || !!resource.error)}
          />
          <PageSizeSelect label="월별 완독 도서" paging={paging} />
        </div>
      )}
    </section>
  );
}
