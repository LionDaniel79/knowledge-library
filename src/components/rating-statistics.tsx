"use client";
import { useState } from "react";
import type { Book, Library, ReadingCycle } from "@/lib/domain";
import {
  latestRatedCycles,
  ratingGroup,
  ratingGroups,
  ratingSummary,
} from "@/lib/reading-ratings";
import { usePagedResource } from "./use-paged-resource";
import { useListPagination, PageNavigation } from "./list-pagination";
import { BookCover } from "./book-cover";
import { RatingStars } from "./reading-rating";
type RatingPage = {
  summary: ReturnType<typeof ratingSummary>;
  items: ReadingCycle[];
  books: Book[];
  total: number;
};
export function RatingStatistics({
  library,
  today,
  onOpenBook,
  onRate,
}: {
  library: Library;
  today: string;
  onOpenBook: (id: string) => void;
  onRate: (c: ReadingCycle) => void;
}) {
  const [year, setYear] = useState("all"),
    [group, setGroup] = useState("all");
  const paging = useListPagination("rating-statistics", year + ":" + group);
  const remote = !!library.readingSummary;
  const state = usePagedResource<RatingPage>(
    `/api/reading?ratings=1&year=${year}&group=${group}&offset=${paging.offset}&limit=${paging.size}`,
    remote && paging.ready,
    library,
    { keepPreviousData: true },
  );
  const local = latestRatedCycles(library.cycles, year),
    matched = local.filter(
      (c) => group === "all" || ratingGroup(c.ratingSteps) === group,
    );
  const result = remote
    ? state.data
    : {
        summary: ratingSummary(local),
        items: matched.slice(paging.offset, paging.offset + paging.size),
        books: library.books,
        total: matched.length,
      };
  const years = [
    ...new Set([
      today.slice(0, 4),
      ...Object.keys(library.readingSummary?.months ?? {}).map((m) =>
        m.slice(0, 4),
      ),
      ...library.cycles.flatMap((c) =>
        c.completedOn ? [c.completedOn.slice(0, 4)] : [],
      ),
    ]),
  ]
    .sort()
    .reverse();
  return (
    <section aria-label="별점 통계" className="rating-statistics">
      <div className="section-heading">
        <h2>별점</h2>
        <label>
          연도
          <select
            aria-label="별점 연도"
            value={year}
            onChange={(e) => setYear(e.target.value)}
          >
            <option value="all">전체 기간</option>
            {years.map((y) => (
              <option key={y} value={y}>
                {y}년
              </option>
            ))}
          </select>
        </label>
      </div>
      {state.error && remote && (
        <p role="alert">
          {state.error} <button onClick={state.reload}>다시 조회</button>
        </p>
      )}
      {remote && state.loading && <p role="status">별점을 불러오는 중…</p>}
      {result && (
        <>
          <div className="stat-grid rating-summary">
            <div className="stat-card">
              <span>평균 별점</span>
              <strong>
                {result.summary.average === null
                  ? "—"
                  : result.summary.average.toFixed(1)}
              </strong>
            </div>
            <div className="stat-card">
              <span>평가한 책</span>
              <strong>
                {result.summary.rated}
                <small>권</small>
              </strong>
            </div>
            <div className="stat-card">
              <span>미평가</span>
              <strong>
                {result.summary.unrated}
                <small>권</small>
              </strong>
            </div>
          </div>
          <div className="rating-distribution" aria-label="별점 분포">
            {ratingGroups.slice(1).map((g) => (
              <button
                key={g.id}
                className={group === g.id ? "selected" : ""}
                aria-pressed={group === g.id}
                onClick={() => setGroup(group === g.id ? "all" : g.id)}
              >
                <span>{g.label}</span>
                <span className="rating-bar">
                  <i
                    style={{
                      width: `${((result.summary.groups[g.id] ?? 0) / Math.max(1, result.summary.rated + result.summary.unrated)) * 100}%`,
                    }}
                  />
                </span>
                <b>{result.summary.groups[g.id] ?? 0}</b>
              </button>
            ))}
          </div>
          <div className="rating-filters" aria-label="별점 필터">
            {ratingGroups.map((g) => (
              <button
                className={group === g.id ? "selected" : ""}
                key={g.id}
                aria-pressed={group === g.id}
                onClick={() => setGroup(g.id)}
              >
                {g.label}
              </button>
            ))}
          </div>
          {result.total === 0 ? (
            <p className="empty-state">해당하는 완독 도서가 없습니다.</p>
          ) : (
            <div className="rating-books">
              {result.items.map((c) => {
                const book = result.books.find((b) => b.id === c.bookId);
                return book ? (
                  <article key={c.id}>
                    <button
                      className="rating-book-open"
                      onClick={() => onOpenBook(book.id)}
                    >
                      <BookCover book={book} />
                      <strong>{book.title}</strong>
                      <small>{book.author}</small>
                    </button>
                    <button
                      className="rating-book-score"
                      aria-label={`${book.title} 별점 수정`}
                      onClick={() => onRate(c)}
                    >
                      <RatingStars steps={c.ratingSteps} />
                    </button>
                  </article>
                ) : null;
              })}
            </div>
          )}
          <PageNavigation
            label="별점 도서"
            paging={paging}
            total={result.total}
            busy={remote && (state.loading || !!state.error)}
          />
        </>
      )}
    </section>
  );
}
