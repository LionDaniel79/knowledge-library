"use client";
import { RatingStars } from "./reading-rating";
import type { Note, ReadingCycle } from "../lib/domain";
import {
  useListPagination,
  PageSizeSelect,
  PageNavigation,
} from "./list-pagination";
import { usePagedResource } from "./use-paged-resource";
export function BookRecords({
  bookId,
  onNote,
  onCycle,
  onRate,
  revision,
}: {
  bookId: string;
  onNote: (id: string) => void;
  onCycle: (c: ReadingCycle) => void;
  onRate?: (c: ReadingCycle) => void;
  revision: unknown;
}) {
  const notePaging = useListPagination("book-notes", bookId);
  const cyclePaging = useListPagination("book-reading", bookId);
  const notes = usePagedResource<{ items: Note[]; total: number }>(
    `/api/notes?book=${bookId}&limit=${notePaging.size}&offset=${notePaging.offset}`,
    notePaging.ready,
    revision,
  );
  const cycles = usePagedResource<{ items: ReadingCycle[]; total: number }>(
    `/api/reading?book=${bookId}&limit=${cyclePaging.size}&offset=${cyclePaging.offset}`,
    cyclePaging.ready,
    revision,
  );
  return (
    <>
      <div className="book-records-header">
        <h3>독서이력 {cycles.data?.total ?? 0}개</h3>
        <PageSizeSelect label="책별 독서 이력" paging={cyclePaging} compact />
      </div>
      {cycles.error && (
        <p role="alert">
          {cycles.error} <button onClick={cycles.reload}>다시 조회</button>
        </p>
      )}
      {cycles.loading && <p role="status">독서 이력을 불러오는 중…</p>}
      {cycles.data?.items.map((c) => (
        <div className="completed-row" key={c.id}>
          <span>
            {c.status === "reading"
              ? "읽는 중"
              : (c.completedOn ?? "날짜 미입력") + " 완독"}{" "}
            · {c.currentPage}쪽
          </span>
          <button onClick={() => onCycle(c)}>수정</button>
          {c.status === "completed" &&
            (onRate ? (
              <button aria-label="별점 수정" onClick={() => onRate(c)}>
                <RatingStars steps={c.ratingSteps} />
              </button>
            ) : (
              <RatingStars steps={c.ratingSteps} />
            ))}
        </div>
      ))}
      {cycles.data?.total === 0 && <p>아직 독서 기록이 없습니다.</p>}
      <PageNavigation
        label="책별 독서 이력"
        paging={cyclePaging}
        total={cycles.data?.total ?? 0}
        busy={cycles.loading || !!cycles.error}
      />
      <div className="book-records-header">
        <h3>기록 {notes.data?.total ?? 0}개</h3>
        <PageSizeSelect label="책별 기록" paging={notePaging} compact />
      </div>
      {notes.error && (
        <p role="alert">
          {notes.error} <button onClick={notes.reload}>다시 조회</button>
        </p>
      )}
      {notes.loading && <p role="status">기록을 불러오는 중…</p>}
      {notes.data?.items.map((n) => (
        <details key={n.id} className="book-record-details">
          <summary>{n.title}</summary>
          <p>{n.content}</p>
          <button className="secondary" onClick={() => onNote(n.id)}>
            기록 열기
          </button>
        </details>
      ))}
      <PageNavigation
        label="책별 기록"
        paging={notePaging}
        total={notes.data?.total ?? 0}
        busy={notes.loading || !!notes.error}
      />
    </>
  );
}
