"use client";
import { Fragment, useMemo, useState, type ReactNode } from "react";
import type { Book, Note, Library } from "@/lib/domain";
import { categoryName } from "@/lib/catalog";
import { BookCover } from "./book-cover";
import { useBookCatalog } from "./use-book-catalog";
import { useNotePage } from "./use-note-page";
import {
  useListPagination,
  PageSizeSelect,
  PageNavigation,
} from "./list-pagination";
export type SearchCards = {
  renderBook?: (book: Book) => ReactNode;
  renderNote?: (note: Note) => ReactNode;
};
export function IntegratedSearch({
  library,
  onOpen,
  renderBook,
  renderNote,
}: {
  library: Library;
  onOpen: (kind: string, id: string) => void;
} & SearchCards) {
  const [text, setText] = useState(""),
    [revision, setRevision] = useState(0);
  const needle = text.trim().toLocaleLowerCase(),
    remote = !!library.catalog;
  const bookPaging = useListPagination("books", needle),
    notePaging = useListPagination("notes", needle);
  const refresh = useMemo(() => ({ library, revision }), [library, revision]);
  const books = useBookCatalog({
    enabled: remote && !!needle && bookPaging.ready,
    query: {
      q: needle,
      sort: "newest",
      limit: bookPaging.size,
      offset: bookPaging.offset,
    },
    revision: refresh,
  });
  const notes = useNotePage(
    remote && !!needle && notePaging.ready,
    { q: needle, limit: notePaging.size, offset: notePaging.offset },
    refresh,
  );
  const local = useMemo(() => {
    if (remote || !needle) return { books: [], notes: [] };
    const byBook = new Map(library.books.map((b) => [b.id, b]));
    return {
      books: library.books.filter((b) =>
        [
          b.title,
          b.author,
          b.publisher,
          b.isbn,
          b.shelf,
          categoryName(b.category),
          ...(b.bookshelves ?? []),
          ...b.tags,
        ]
          .join(" ")
          .toLocaleLowerCase()
          .includes(needle),
      ),
      notes: library.notes.filter((n) =>
        [
          n.title,
          n.content,
          ...(n.tags ?? []),
          byBook.get(n.bookId ?? "")?.title ?? "",
        ]
          .join(" ")
          .toLocaleLowerCase()
          .includes(needle),
      ),
    };
  }, [library, remote, needle]);
  const bookCount = remote ? books.total : local.books.length,
    noteCount = remote ? notes.total : local.notes.length;
  const shownBooks = remote
      ? books.items
      : local.books.slice(
          bookPaging.offset,
          bookPaging.offset + bookPaging.size,
        ),
    shownNotes = remote
      ? notes.items
      : local.notes.slice(
          notePaging.offset,
          notePaging.offset + notePaging.size,
        );
  return (
    <section className="integrated-search">
      <form
        className="integrated-search-form"
        onSubmit={(e) => {
          e.preventDefault();
          setRevision((n) => n + 1);
        }}
      >
        <label>
          검색
          <div className="integrated-search-input">
            <input
              type="search"
              aria-label="통합 검색어"
              placeholder="책, 저자, 내 생각을 검색하세요"
              value={text}
              maxLength={200}
              onChange={(e) => setText(e.target.value)}
            />
            {text && (
              <button
                type="button"
                className="clear-search"
                aria-label="검색 지우기"
                onClick={() => setText("")}
              >
                ×
              </button>
            )}
          </div>
        </label>
        <button className="primary">검색</button>
      </form>
      {!!needle && (
        <section data-testid="search-results">
          <div className="section-heading">
            <h2>
              책 <span className="count">{bookCount}</span>
            </h2>
          </div>
          <PageSizeSelect label="검색 도서" paging={bookPaging} />
          {books.loading && remote && <p role="status">도서를 찾는 중…</p>}
          {books.error && remote && (
            <p role="alert">
              {books.error}
              <button onClick={books.reload}>도서 다시 조회</button>
            </p>
          )}
          <div className="shelf-grid">
            {shownBooks.map((b) => (
              <Fragment key={b.id}>
                {renderBook ? (
                  renderBook(b)
                ) : (
                  <button
                    className="shelf-card"
                    onClick={() => onOpen("book", b.id)}
                  >
                    <BookCover book={b} />
                    <strong>{b.title}</strong>
                    <span>{b.author}</span>
                  </button>
                )}
              </Fragment>
            ))}
          </div>
          <PageNavigation
            label="검색 도서"
            paging={bookPaging}
            total={bookCount}
            busy={remote && (books.loading || !!books.error)}
          />
          <h2 className="section-space">
            내 기록 <span className="count">{noteCount}</span>
          </h2>
          <PageSizeSelect label="검색 기록" paging={notePaging} />
          {notes.loading && remote && <p role="status">기록을 찾는 중…</p>}
          {notes.error && remote && (
            <p role="alert">
              {notes.error}
              <button onClick={() => setRevision((n) => n + 1)}>
                기록 다시 조회
              </button>
            </p>
          )}
          <div className="notes-grid">
            {shownNotes.map((n) => (
              <Fragment key={n.id}>
                {renderNote ? (
                  renderNote(n)
                ) : (
                  <article className="note-card">
                    <button
                      className="title-button"
                      onClick={() => onOpen("note", n.id)}
                    >
                      <h3>{n.title}</h3>
                    </button>
                    <p>{n.content}</p>
                  </article>
                )}
              </Fragment>
            ))}
          </div>
          <PageNavigation
            label="검색 기록"
            paging={notePaging}
            total={noteCount}
            busy={remote && (notes.loading || !!notes.error)}
          />
          {!bookCount &&
            !noteCount &&
            (!remote ||
              (!books.loading &&
                !notes.loading &&
                !books.error &&
                !notes.error)) && (
              <p className="empty-state">
                일치하는 기록이 없습니다. 다른 단어로 찾아보세요.
              </p>
            )}
        </section>
      )}
    </section>
  );
}
