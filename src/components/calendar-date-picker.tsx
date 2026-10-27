"use client";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, CalendarDays } from "lucide-react";
import { monthCells, shiftMonth } from "@/lib/domain";

export function CalendarDatePicker({
  month,
  selected,
  today,
  onSelect,
}: {
  month: string;
  selected: string;
  today: string;
  onSelect: (day: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(month);
  const anchor = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const activeDay = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    activeDay.current?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      if (!anchor.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const year = Number(shown.slice(0, 4));
  const firstYear = Math.min(1900, year);
  const lastYear = Math.max(Number(today.slice(0, 4)) + 10, year);
  function close() {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  }
  function choose(day: string) {
    onSelect(day);
    close();
  }
  return (
    <div
      className="calendar-jump-anchor"
      ref={anchor}
      onKeyDown={(event) => {
        if (open && event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="icon-button"
        aria-label="날짜 이동"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          if (!open) setShown(month);
          setOpen(!open);
        }}
      >
        <CalendarDays size={20} aria-hidden="true" />
      </button>
      {open && (
        <div className="calendar-jump" role="dialog" aria-label="날짜 선택">
          <div className="calendar-jump-heading">
            <button
              type="button"
              className="icon-button"
              aria-label="날짜 선택 이전 달"
              onClick={() => setShown(shiftMonth(shown, -1))}
            >
              <ArrowLeft size={17} />
            </button>
            <select
              aria-label="이동 연도"
              value={shown.slice(0, 4)}
              onChange={(event) =>
                setShown(event.target.value + shown.slice(4))
              }
            >
              {Array.from(
                { length: lastYear - firstYear + 1 },
                (_, i) => firstYear + i,
              ).map((y) => (
                <option key={y} value={String(y)}>
                  {y}년
                </option>
              ))}
            </select>
            <select
              aria-label="이동 월"
              value={shown.slice(5)}
              onChange={(event) =>
                setShown(shown.slice(0, 5) + event.target.value)
              }
            >
              {Array.from({ length: 12 }, (_, i) =>
                String(i + 1).padStart(2, "0"),
              ).map((m) => (
                <option key={m} value={m}>
                  {Number(m)}월
                </option>
              ))}
            </select>
            <button
              type="button"
              className="icon-button"
              aria-label="날짜 선택 다음 달"
              onClick={() => setShown(shiftMonth(shown, 1))}
            >
              <ArrowRight size={17} />
            </button>
          </div>
          <div className="calendar-jump-weekdays" aria-hidden="true">
            {["일", "월", "화", "수", "목", "금", "토"].map((day) => (
              <span key={day}>{day}</span>
            ))}
          </div>
          <div className="calendar-jump-grid">
            {monthCells(shown).map((day) => (
              <button
                key={day}
                ref={
                  day ===
                  (selected.startsWith(shown) ? selected : shown + "-01")
                    ? activeDay
                    : undefined
                }
                type="button"
                aria-label={day}
                aria-pressed={selected === day}
                aria-current={day === today ? "date" : undefined}
                className={day.startsWith(shown) ? "" : "outside"}
                onClick={() => choose(day)}
              >
                {Number(day.slice(8))}
              </button>
            ))}
          </div>
          <div className="calendar-jump-footer">
            <button type="button" onClick={() => choose(today)}>
              오늘
            </button>
            <button type="button" onClick={close}>
              닫기
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
