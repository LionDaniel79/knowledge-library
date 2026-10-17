"use client";
import { useRef } from "react";
import { ArrowLeft, ArrowRight, BookOpen, Check } from "lucide-react";
import { carouselIndex, type Library, type ReadingCycle } from "@/lib/domain";
import { BookCover } from "./book-cover";
export function ReadingCarousel({
  library,
  index,
  onIndexChange,
  onProgress,
  onComplete,
  onBook,
}: {
  library: Library;
  index: number;
  onIndexChange: (index: number) => void;
  onProgress: (c: ReadingCycle) => void;
  onComplete: (c: ReadingCycle) => void;
  onBook: (id: string) => void;
}) {
  const reading = library.cycles
    .filter((c) => c.status === "reading")
    .sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
  const current = Math.min(index, Math.max(0, reading.length - 1));
  const pointer = useRef<{ x: number; y: number; id: number } | null>(null);
  const move = (d: number) =>
    onIndexChange(carouselIndex(current, d, reading.length));
  const cycle = reading[current];
  const book = library.books.find((b) => b.id === cycle?.bookId);
  return (
    <section className="panel reading-panel">
      <div className="section-heading">
        <div>
          <span className="eyebrow">KEEP READING</span>
          <h2>
            지금 읽는 책 <span className="count">{reading.length}</span>
          </h2>
        </div>
        <div className="carousel-controls">
          <button
            className="icon-button"
            aria-label="이전 책"
            disabled={current === 0}
            onClick={() => move(-1)}
          >
            <ArrowLeft size={17} />
          </button>
          <button
            className="icon-button"
            aria-label="다음 책"
            disabled={!reading.length || current === reading.length - 1}
            onClick={() => move(1)}
          >
            <ArrowRight size={17} />
          </button>
        </div>
      </div>
      {book && cycle ? (
        <>
          <div
            className="reading-carousel"
            data-testid="reading-carousel"
            role="region"
            aria-label="읽는 책, 좌우 방향키로 이동"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget) return;
              if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                e.preventDefault();
                move(e.key === "ArrowLeft" ? -1 : 1);
              }
            }}
            onPointerDown={(e) => {
              if ((e.target as HTMLElement).closest("button")) return;
              pointer.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerCancel={() => {
              pointer.current = null;
            }}
            onPointerUp={(e) => {
              const p = pointer.current;
              pointer.current = null;
              if (!p) return;
              const dx = e.clientX - p.x,
                dy = e.clientY - p.y;
              if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy))
                move(dx < 0 ? 1 : -1);
            }}
          >
            <BookCover book={book} />
            <div className="reading-copy">
              <div className="tags">
                {book.tags.map((t) => (
                  <span key={t}>{t}</span>
                ))}
                <span>{book.formats.includes("paper") ? "종이책" : "PDF"}</span>
              </div>
              <button className="title-button" onClick={() => onBook(book.id)}>
                <h3>{book.title}</h3>
              </button>
              <p className="muted">{book.author || "저자 미입력"}</p>
              <div className="reading-progress">
                <div>
                  <span>
                    {cycle.currentPage}{" "}
                    <small>/ {book.totalPages ?? "?"}쪽</small>
                  </span>
                  <b>
                    {book.totalPages
                      ? Math.round(
                          (cycle.currentPage / book.totalPages) * 100,
                        ) + "%"
                      : "읽는 중"}
                  </b>
                </div>
                <progress
                  value={cycle.currentPage}
                  max={book.totalPages || Math.max(cycle.currentPage, 1)}
                  aria-label="독서 진행률"
                />
              </div>
              <div className="reading-actions">
                <button className="primary" onClick={() => onProgress(cycle)}>
                  <BookOpen size={15} />
                  읽은 쪽 기록
                </button>
                <button
                  className="text-button"
                  onClick={() => onComplete(cycle)}
                >
                  <Check size={15} />
                  완독
                </button>
              </div>
            </div>
          </div>
          <div className="carousel-footer">
            <span>좌우로 밀어 다음 책을 만나세요</span>
            <span data-testid="carousel-position" aria-live="polite">
              {current + 1} / {reading.length}
            </span>
          </div>
        </>
      ) : (
        <div className="empty-state">
          <BookOpen />
          <h3>다음 문장을 만나볼까요?</h3>
          <p>소장 도서에서 책을 선택하고 ‘읽기 시작’을 눌러 주세요.</p>
        </div>
      )}
    </section>
  );
}
