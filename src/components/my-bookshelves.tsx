"use client";
import { useState, type ReactNode } from "react";
import { ArrowLeft, ChevronRight } from "lucide-react";
import type { Book, Library } from "@/lib/domain";
import { defaultShelves } from "@/lib/catalog";
import { BookCover } from "./book-cover";
import { useBookCatalog } from "./use-book-catalog";
import {
  PageNavigation,
  PageSizeSelect,
  useListPagination,
} from "./list-pagination";

export function MyBookshelves({
  library,
  renderBook,
}: {
  library: Library;
  renderBook: (book: Book) => ReactNode;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const shelves = [
    ...new Set([
      ...defaultShelves,
      ...(library.shelves ?? []),
      ...library.books.flatMap((book) => book.bookshelves ?? []),
    ]),
  ];
  return selected ? (
    <section className="my-bookshelves" aria-label="선택한 책장">
      <div className="my-shelf-heading">
        <button onClick={() => setSelected(null)}>
          <ArrowLeft size={16} />
          책장 목록
        </button>
        <h2>{selected}</h2>
      </div>
      <ShelfBooks
        key={selected}
        name={selected}
        library={library}
        renderBook={renderBook}
      />
    </section>
  ) : (
    <section className="my-bookshelves" aria-label="책장 목록">
      {shelves.map((name) => (
        <ShelfPreview
          key={name}
          name={name}
          library={library}
          onSelect={() => setSelected(name)}
        />
      ))}
    </section>
  );
}

function ShelfPreview({
  name,
  library,
  onSelect,
}: {
  name: string;
  library: Library;
  onSelect: () => void;
}) {
  const remote = !!library.catalog;
  const catalog = useBookCatalog({
    enabled: remote,
    query: { shelf: name, sort: "newest", limit: 5, offset: 0 },
    revision: library,
  });
  const local = library.books.filter((book) =>
    book.bookshelves?.includes(name),
  );
  const items = remote ? catalog.items : local.slice(0, 5);
  const total = remote ? catalog.total : local.length;
  return (
    <div className="my-shelf-row">
      <button
        className="my-shelf-preview"
        onClick={onSelect}
        aria-label={`${name} 책장 열기`}
      >
        <div className="my-shelf-covers" aria-hidden="true">
          {items.map((book) => (
            <BookCover key={book.id} book={book} small />
          ))}
          {!items.length && (
            <span className="muted">
              {catalog.loading
                ? "책장을 불러오는 중…"
                : catalog.error
                  ? "책장 조회 실패"
                  : "아직 담긴 책이 없습니다"}
            </span>
          )}
        </div>
        <span className="my-shelf-label">
          <strong>{name}</strong>
          <span>
            {catalog.loading ? "…" : catalog.error ? "조회 실패" : `${total}권`}
            <ChevronRight size={16} />
          </span>
        </span>
      </button>
      {catalog.error && (
        <p className="error" role="alert">
          {catalog.error} <button onClick={catalog.reload}>다시 조회</button>
        </p>
      )}
    </div>
  );
}

function ShelfBooks({
  name,
  library,
  renderBook,
}: {
  name: string;
  library: Library;
  renderBook: (book: Book) => ReactNode;
}) {
  const paging = useListPagination("my-bookshelves", name);
  const remote = !!library.catalog;
  const catalog = useBookCatalog({
    enabled: remote && paging.ready,
    query: {
      shelf: name,
      sort: "newest",
      limit: paging.size,
      offset: paging.offset,
    },
    revision: library,
  });
  const local = library.books
    .filter((book) => book.bookshelves?.includes(name))
    .sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    );
  const items = remote
    ? catalog.items
    : local.slice(paging.offset, paging.offset + paging.size);
  const total = remote ? catalog.total : local.length;
  return (
    <>
      <div className="my-shelf-toolbar">
        <span>{total}권</span>
        <PageSizeSelect label="책장 도서" paging={paging} />
      </div>
      {catalog.error ? (
        <p className="error" role="alert">
          {catalog.error} <button onClick={catalog.reload}>다시 조회</button>
        </p>
      ) : catalog.loading ? (
        <p role="status">도서를 불러오고 있습니다…</p>
      ) : items.length ? (
        <div className="my-shelf-books">{items.map(renderBook)}</div>
      ) : (
        <div className="panel empty-state">
          <h3>이 책장에 담긴 책이 없습니다</h3>
          <p>도서 상세정보의 ‘책장’에서 책을 담아 보세요.</p>
        </div>
      )}
      <PageNavigation
        label="책장 도서"
        paging={paging}
        total={total}
        busy={catalog.loading || !!catalog.error}
      />
    </>
  );
}
