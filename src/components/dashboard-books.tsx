"use client";
import type { ReactNode } from "react";
import type { Book, Library, ReadingCycle } from "@/lib/domain";
import { recentCompletedCycles } from "@/lib/recent-reading";
import {
  PageNavigation,
  PageSizeSelect,
  useListPagination,
} from "./list-pagination";
import { useBookCatalog } from "./use-book-catalog";
import { usePagedResource } from "./use-paged-resource";

type Props = { library: Library; renderBook: (book: Book) => ReactNode };
export function QueuedBooks({ library, renderBook }: Props) {
  const paging = useListPagination("home-queue");
  const remote = !!library.catalog;
  const catalog = useBookCatalog({
    enabled: remote && paging.ready,
    query: {
      shelf: "책 대기열",
      sort: "newest",
      limit: paging.size,
      offset: paging.offset,
    },
    revision: library,
  });
  const local = (remote ? [] : library.books)
    .filter((b) => b.bookshelves?.includes("책 대기열"))
    .sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    );
  const items = remote
    ? catalog.items
    : local.slice(paging.offset, paging.offset + paging.size);
  return (
    <HomeBookSection
      label="책 대기열"
      description="다음으로 펼쳐 볼 책"
      total={remote ? catalog.total : local.length}
      paging={paging}
      loading={remote && (!paging.ready || catalog.loading)}
      error={catalog.error}
      reload={catalog.reload}
      empty="책 대기열에 담긴 책이 없습니다."
    >
      {items.map(renderBook)}
    </HomeBookSection>
  );
}
export function RecentCompletedBooks({
  library,
  today,
  renderBook,
}: Props & { today: string }) {
  const paging = useListPagination("home-recent-completed", today);
  const remote = !!library.catalog || !!library.readingSummary;
  const resource = usePagedResource<{
    items: ReadingCycle[];
    books: Book[];
    total: number;
  }>(
    `/api/reading?recentThrough=${today}&limit=${paging.size}&offset=${paging.offset}`,
    remote && paging.ready,
    library,
  );
  const local = remote ? [] : recentCompletedCycles(library.cycles, today);
  const cycles = remote
    ? (resource.data?.items ?? [])
    : local.slice(paging.offset, paging.offset + paging.size);
  const books = new Map(
    (remote ? (resource.data?.books ?? []) : library.books).map((book) => [
      book.id,
      book,
    ]),
  );
  return (
    <HomeBookSection
      label="최근 읽은 책"
      description="오늘을 포함한 최근 30일 · 책마다 마지막 완독"
      total={remote ? (resource.data?.total ?? 0) : local.length}
      paging={paging}
      loading={remote && (!paging.ready || resource.loading)}
      error={resource.error}
      reload={resource.reload}
      empty="최근 30일 동안 완독한 책이 없습니다."
    >
      {cycles.map((c) => {
        const book = books.get(c.bookId);
        return book ? (
          <div
            key={c.bookId}
            style={{ display: "grid", minWidth: 0, alignContent: "start" }}
          >
            {renderBook(book)}
            <p className="muted">
              <time dateTime={c.completedOn!}>{c.completedOn}</time> 완독
            </p>
          </div>
        ) : null;
      })}
    </HomeBookSection>
  );
}
function HomeBookSection({
  label,
  description,
  total,
  paging,
  loading,
  error,
  reload,
  empty,
  children,
}: {
  label: string;
  description: string;
  total: number;
  paging: ReturnType<typeof useListPagination>;
  loading: boolean;
  error: string;
  reload: () => void;
  empty: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={label}
      className="dashboard-book-section"
      style={{ marginTop: 28 }}
    >
      <div className="section-heading">
        <div>
          <h2>{label}</h2>
          <p className="muted">{description}</p>
        </div>
        <span>{total}권</span>
      </div>
      {loading ? (
        <p role="status">책을 불러오는 중…</p>
      ) : error ? (
        <p role="alert">
          {error} <button onClick={reload}>다시 조회</button>
        </p>
      ) : total ? (
        <div className="shelf-grid">{children}</div>
      ) : (
        <p className="panel empty-state">{empty}</p>
      )}
      {total > 0 && (
        <>
          <PageNavigation
            label={label}
            paging={paging}
            total={total}
            busy={loading || !!error}
          />
          <PageSizeSelect label={label} paging={paging} />
        </>
      )}
    </section>
  );
}
