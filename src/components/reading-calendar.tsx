"use client";
import { ArrowLeft, ArrowRight, CalendarDays } from "lucide-react";
import {
  monthCells,
  shiftMonth,
  type Library,
  type ReadingCycle,
} from "@/lib/domain";
import { BookCover } from "./book-cover";
export function ReadingCalendar({
  library,
  month,
  setMonth,
  selected,
  setSelected,
  onEdit,
  today,
}: {
  library: Library;
  month: string;
  setMonth: (m: string) => void;
  selected: string;
  setSelected: (d: string) => void;
  onEdit: (c: ReadingCycle) => void;
  today: string;
}) {
  const completed = library.cycles.filter(
    (c) => c.status === "completed" && c.completedOn,
  );
  const forDay = (day: string) =>
    completed.filter((c) => c.completedOn === day);
  return (
    <section className="panel calendar-panel">
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
          const book = library.books.find((b) => b.id === list[0]?.bookId);
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
                  {list.length > 1 && <i>+{list.length - 1}</i>}
                </div>
              )}
            </button>
          );
        })}
      </div>
      <div className="date-detail" data-testid="selected-date-books">
        <div className="date-label">
          {Number(selected.slice(5, 7))}월 {Number(selected.slice(8))}일{" "}
          <span>{forDay(selected).length}권 완독</span>
        </div>
        {forDay(selected).length ? (
          forDay(selected).map((c) => (
            <div className="completed-row" key={c.id}>
              <span>{library.books.find((b) => b.id === c.bookId)?.title}</span>
              <button className="text-button" onClick={() => onEdit(c)}>
                날짜 수정
              </button>
            </div>
          ))
        ) : (
          <p className="muted">이날의 완독 기록이 없습니다.</p>
        )}
      </div>
    </section>
  );
}
