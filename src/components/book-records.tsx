"use client";
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
  revision,
}: {
  bookId: string;
  onNote: (id: string) => void;
  onCycle: (c: ReadingCycle) => void;
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
      <h3>독서 이력 {cycles.data?.total ?? ""}</h3>
      <PageSizeSelect label="책별 독서 이력" paging={cyclePaging} />
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
        </div>
      ))}
      {cycles.data?.total === 0 && <p>아직 독서 기록이 없습니다.</p>}
      <PageNavigation
        label="책별 독서 이력"
        paging={cyclePaging}
        total={cycles.data?.total ?? 0}
        busy={cycles.loading || !!cycles.error}
      />
      <h3>이 책에 남긴 기록 {notes.data?.total ?? ""}</h3>
      <PageSizeSelect label="책별 기록" paging={notePaging} />
      {notes.error && (
        <p role="alert">
          {notes.error} <button onClick={notes.reload}>다시 조회</button>
        </p>
      )}
      {notes.loading && <p role="status">기록을 불러오는 중…</p>}
      {notes.data?.items.map((n) => (
        <article key={n.id} className="note-card">
          <button onClick={() => onNote(n.id)}>
            <strong>{n.title}</strong>
            <p>{n.content}</p>
          </button>
        </article>
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
