"use client";
import { libraryRequest } from "@/client/replica/request";
import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, CalendarDays } from "lucide-react";
import {
  monthCells,
  shiftMonth,
  type Library,
  type ReadingCycle,
} from "@/lib/domain";
import { useListPagination, PageNavigation } from "./list-pagination";
import { usePagedResource } from "./use-paged-resource";
import { BookCover } from "./book-cover";
export function ReadingCalendar({
  library,
  month,
  setMonth,
  selected,
  setSelected,
  onEdit,
  onOpenBook,
  today,
}: {
  library: Library;
  month: string;
  setMonth: (m: string) => void;
  selected: string;
  setSelected: (d: string) => void;
  onEdit: (c: ReadingCycle) => void;
  onOpenBook?: (bookId: string) => void;
  today: string;
}) {
  const remote = !!library.readingSummary;
  const [calendar, setCalendar] = useState<any>(null),
    [error, setError] = useState("");
  useEffect(() => {
    if (!remote) return;
    const c = new AbortController();
    setCalendar(null);
    setError("");
    libraryRequest(`/api/reading?month=${month}`, {
      signal: c.signal,
      cache: "no-store",
    })
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw Error(j.error);
        setCalendar(j);
      })
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => c.abort();
  }, [remote, month, library]);
  const paging = useListPagination("calendar-day", selected);
  const dayState = usePagedResource<{
    items: ReadingCycle[];
    books: Library["books"];
    total: number;
  }>(
    `/api/reading?date=${selected}&limit=${paging.size}&offset=${paging.offset}`,
    remote && paging.ready,
    library,
  );
  const dayPage = dayState.data;
  const books = remote
    ? [...(calendar?.books ?? []), ...(dayPage?.books ?? [])]
    : library.books;
  const completed: ReadingCycle[] = (
    remote ? (calendar?.days ?? []) : library.cycles
  ).filter((c: ReadingCycle) => c.status === "completed" && c.completedOn);
  const forDay = (day: string) =>
    completed.filter((c) => c.completedOn === day);
  const dayCount = (day: string) =>
    remote
      ? (calendar?.days.find((c: any) => c.completedOn === day)?.total ?? 0)
      : forDay(day).length;
  const selectedCycles: ReadingCycle[] = remote
    ? (dayPage?.items ?? [])
    : forDay(selected);
  const selectedCount = remote ? (dayPage?.total ?? 0) : selectedCycles.length;
  return (
    <section className="panel calendar-panel">
      {error && <p role="alert">{error}</p>}
      {remote && !calendar && !error && (
        <p role="status">달력을 불러오는 중…</p>
      )}
      <div className="section-heading">
        <div>
          <span className="eyebrow">READING DAYS</span>
          <h2>책으로 채운 달력</h2>
        </div>
        <CalendarDays size={20} className="muted" />
      </div>
      <div className="month-selector">
        <button
          className="icon-button"
          aria-label="이전 달"
          onClick={() => setMonth(shiftMonth(month, -1))}
        >
          <ArrowLeft size={17} />
        </button>
        <strong>
          {month.slice(0, 4)}년 {Number(month.slice(5))}월
        </strong>
        <button
          className="icon-button"
          aria-label="다음 달"
          onClick={() => setMonth(shiftMonth(month, 1))}
        >
          <ArrowRight size={17} />
        </button>
      </div>
      <div className="weekdays">
        {["일", "월", "화", "수", "목", "금", "토"].map((d) => (
          <span key={d}>{d}</span>
        ))}
      </div>
      <div className="calendar-grid">
        {monthCells(month).map((day) => {
          const list = forDay(day);
          const book = books.find((b) => b.id === list[0]?.bookId);
          return (
            <button
              key={day}
              aria-label={day}
              aria-pressed={selected === day}
              className={
                "calendar-day" +
                (!day.startsWith(month) ? " outside" : "") +
                (selected === day ? " selected" : "") +
                (day === today ? " today" : "")
              }
              onClick={() => {
                setSelected(day);
                if (!day.startsWith(month)) setMonth(day.slice(0, 7));
              }}
            >
              <span>{Number(day.slice(8))}</span>
              {book && (
                <div className="calendar-cover">
                  <BookCover book={book} small />
                  {dayCount(day) > 1 && <i>+{dayCount(day) - 1}</i>}
                </div>
              )}
            </button>
          );
        })}
      </div>
      <div className="date-detail" data-testid="selected-date-books">
        <div className="date-label">
          {Number(selected.slice(5, 7))}월 {Number(selected.slice(8))}일{" "}
          <span>{selectedCount}권 완독</span>
        </div>
        {selectedCycles.length ? (
          (remote
            ? selectedCycles
            : selectedCycles.slice(paging.offset, paging.offset + paging.size)
          ).map((c) => (
            <div className="completed-row" key={c.id}>
              <span>{books.find((b) => b.id === c.bookId)?.title}</span>
              <button className="text-button" onClick={() => onEdit(c)}>
                날짜 수정
              </button>
              {onOpenBook && (
                <button
                  className="text-button"
                  onClick={() => onOpenBook(c.bookId)}
                >
                  세부정보
                </button>
              )}
            </div>
          ))
        ) : (
          <p className="muted">이날의 완독 기록이 없습니다.</p>
        )}
      </div>
      {dayState.error && (
        <p role="alert">
          {dayState.error} <button onClick={dayState.reload}>다시 조회</button>
        </p>
      )}
      <PageNavigation
        label="이날의 책"
        paging={paging}
        total={selectedCount}
        busy={dayState.loading || !!dayState.error}
      />
    </section>
  );
}
