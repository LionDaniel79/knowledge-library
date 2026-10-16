"use client";
import { CatalogAttribution } from "./catalog-attribution";
import { NoteTagFilter } from "./note-tag-filter";
import { NoteTrash } from "./note-trash";
import { OfflineDrafts } from "./offline-drafts";
import { newDraft, writeDraft, offlineOwnerKey } from "@/lib/offline-drafts";
import { useEffect, useMemo, useState } from "react";
import {
  BookOpen,
  Menu,
  LibraryBig,
  LayoutDashboard,
  CalendarDays,
  ChartNoAxesCombined,
  NotebookPen,
  Search,
  Plus,
  ArrowUpRight,
  Download,
  LogOut,
  CloudCheck,
  Feather,
  History,
  RefreshCw,
  FileText,
} from "lucide-react";
import {
  readingStats,
  formatNames,
  type Format,
  type Library,
  type ReadingCycle,
  type Book,
  type Note,
  type Command,
  type Revision,
} from "@/lib/domain";
import { authClient } from "@/lib/auth-client";
import { BookCover } from "./book-cover";
import { ReadingCarousel } from "./reading-carousel";
import { ReadingCalendar } from "./reading-calendar";
import { LibraryForm, type Editor } from "./library-forms";
import { Modal } from "./modal";
import { RevisionContent } from "./revision-content";
import { ImportPanel } from "./import-panel";
import { PdfLibraryPanel } from "./pdf-library-panel";
import { KnowledgePanel } from "./knowledge-panel";
import { NavigationDrawer } from "./navigation-drawer";
import { BookShelves } from "./shelf-picker";
import { LibrarySearchPanel } from "./library-search-panel";
import { BookRecords } from "./book-records";
import { useNotePage } from "./use-note-page";
import { BookIntroduction } from "./book-introduction";
import { CatalogReviewPanel } from "./catalog-review-panel";
import { CurationDetails } from "./curation-details";
import { BookRelations } from "./book-relations";
import { PdfIdentityEvidence } from "./pdf-identity-evidence";
import { BackupPanel } from "./backup-panel";
import { useBookCatalog } from "./use-book-catalog";
import { categories, categoryName, defaultShelves } from "@/lib/catalog";
type View =
  | "home"
  | "books"
  | "notes"
  | "calendar"
  | "stats"
  | "pdf"
  | "knowledge"
  | "search";
const navigation = [
  { id: "home", label: "나의 서재", icon: LayoutDashboard },
  { id: "books", label: "소장 도서", icon: LibraryBig },
  { id: "notes", label: "기록과 생각", icon: NotebookPen },
  { id: "search", label: "통합 검색", icon: Search },
  { id: "pdf", label: "PDF 원문 검색", icon: FileText },
  { id: "knowledge", label: "사유의 지도", icon: Feather },
  { id: "calendar", label: "독서 달력", icon: CalendarDays },
  { id: "stats", label: "독서 통계", icon: ChartNoAxesCombined },
] as const;
const kindName = {
  thought: "나의 생각",
  claim: "주장",
  evidence: "근거",
  counterargument: "반론",
  reflection: "생각의 변화",
  note: "독서 메모",
  highlight: "하이라이트",
  review: "서평",
};
export function LibraryApp({
  initial,
  today,
  preview = false,
  ownerId = "",
}: {
  initial: Library;
  today: string;
  preview?: boolean;
  ownerId?: string;
}) {
  const [draftRevision, setDraftRevision] = useState(0);
  async function keepDraft(c: Command) {
    writeDraft(localStorage, newDraft(ownerId, c));
    setDraftRevision((n) => n + 1);
    setMessage(
      "이 기기에 임시 저장했습니다. 화면 아래 임시 기록에서 서재에 반영할 수 있습니다.",
    );
  }
  const [menuOpen, setMenuOpen] = useState(false);
  const [sort, setSort] = useState("newest");
  const [bookLayout, setBookLayout] = useState<"covers" | "list">("covers");
  const layoutKey = `library:book-layout:${ownerId || "default"}`;
  useEffect(() => {
    try {
      setBookLayout(
        localStorage.getItem(layoutKey) === "list" ? "list" : "covers",
      );
    } catch {}
  }, [layoutKey]);
  function chooseBookLayout(value: "covers" | "list") {
    setBookLayout(value);
    try {
      localStorage.setItem(layoutKey, value);
    } catch {}
  }
  const [category, setCategory] = useState("all");
  const [shelfFilter, setShelfFilter] = useState("all");
  const [noteTag, setNoteTag] = useState("all");
  const [noteType, setNoteType] = useState("all");
  const [noteBook, setNoteBook] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [importing, setImporting] = useState(false);
  const [catalogReviewOpen, setCatalogReviewOpen] = useState(false);
  const [backupOpen, setBackupOpen] = useState(false);
  const [data, setData] = useState(initial);
  const [view, setView] = useState<View>("home");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [limit, setLimit] = useState(24);
  const [readingIndex, setReadingIndex] = useState(0);
  const [month, setMonth] = useState(today.slice(0, 7));
  const [selected, setSelected] = useState(today);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [failure, setFailure] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [revisions, setRevisions] = useState<Revision[] | null>(null);
  const [detailState, setDetailState] = useState<{
    id: string;
    book?: Book;
    error?: string;
    revision: Library;
  } | null>(null);
  const remote = !!data.catalog;
  const needle = query.trim().toLocaleLowerCase();
  const defaultQuery =
    !needle &&
    sort === "newest" &&
    category === "all" &&
    shelfFilter === "all" &&
    filter === "all";
  const catalog = useBookCatalog({
    enabled: remote,
    query: { q: needle, sort, category, shelf: shelfFilter, filter },
    initial: defaultQuery ? data.catalog?.firstPage : undefined,
    revision: data,
  });
  const totalBooks = data.catalog?.total ?? data.books.length;
  const categoryCount = (id: string) =>
    data.catalog
      ? (data.catalog.categoryCounts[id] ?? 0)
      : data.books.filter((b) => (b.category ?? "") === id).length;
  const formatCount = (format: Format) =>
    data.catalog
      ? data.catalog.formatCounts[format]
      : data.books.filter((b) => b.formats.includes(format)).length;
  const detailBook = remote
    ? detailState?.id === detail && detailState.revision === data
      ? detailState.book
      : undefined
    : data.books.find((b) => b.id === detail);
  const booksById = useMemo(
    () =>
      new Map(
        [
          ...data.books,
          ...catalog.items,
          ...(detailBook ? [detailBook] : []),
        ].map((book) => [book.id, book]),
      ),
    [data.books, catalog.items, detailBook],
  );
  const editorLibrary = remote
    ? { ...data, books: [...booksById.values()] }
    : data;
  useEffect(() => {
    if (!remote || !detail) return;
    const controller = new AbortController();
    setDetailState({
      id: detail,
      book:
        catalog.items.find((b) => b.id === detail) ??
        data.books.find((b) => b.id === detail),
      revision: data,
    });
    void fetch("/api/books/" + detail, {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (res) => {
        const book = await res.json();
        if (!res.ok)
          throw Error(book.error ?? "책 정보를 불러오지 못했습니다.");
        if (!controller.signal.aborted)
          setDetailState({ id: detail, book, revision: data });
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setDetailState((previous) => ({
            id: detail,
            book: previous?.id === detail ? previous.book : undefined,
            error: e.message,
            revision: data,
          }));
      });
    return () => controller.abort();
  }, [detail, remote, data]);
  const statsFor = (m: string) =>
    data.readingSummary
      ? {
          ...readingStats(data.cycles, m),
          ...(data.readingSummary.months[m] ?? {
            monthCount: 0,
            uniqueBooks: 0,
            rereads: 0,
          }),
          yearCount: Object.entries(data.readingSummary.months)
            .filter(([key]) => key.startsWith(m.slice(0, 4)))
            .reduce((sum, [, v]) => sum + v.monthCount, 0),
          undatedCount: data.readingSummary.undatedCount,
        }
      : readingStats(data.cycles, m);
  const stats = useMemo(() => statsFor(month), [data, month]);
  const currentStats = useMemo(
    () => statsFor(today.slice(0, 7)),
    [data, today],
  );
  const readingIds = useMemo(
    () =>
      new Set(
        data.cycles.filter((c) => c.status === "reading").map((c) => c.bookId),
      ),
    [data.cycles],
  );
  const completedIds = useMemo(
    () =>
      new Set(
        data.readingSummary?.completedIds ??
          data.cycles
            .filter((c) => c.status === "completed")
            .map((c) => c.bookId),
      ),
    [data],
  );
  const matchedBooks = remote
    ? catalog.items
    : data.books
        .filter(
          (b) =>
            (!needle ||
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
                .includes(needle)) &&
            (category === "all" ||
              (category === "unclassified"
                ? !b.category
                : category === "review"
                  ? !!b.category && !b.classification?.verified
                  : b.category === category)) &&
            (shelfFilter === "all" ||
              (b.bookshelves ?? []).includes(shelfFilter)) &&
            (filter === "all" ||
              (filter === "reading" && readingIds.has(b.id)) ||
              (filter === "completed" && completedIds.has(b.id)) ||
              b.formats.includes(filter as Format)),
        )
        .sort((a, b) =>
          sort === "title"
            ? a.title.localeCompare(b.title, "ko") || a.id.localeCompare(b.id)
            : sort === "author"
              ? a.author.localeCompare(b.author, "ko") ||
                a.title.localeCompare(b.title, "ko")
              : (sort === "oldest" ? 1 : -1) *
                (a.createdAt.localeCompare(b.createdAt) ||
                  a.id.localeCompare(b.id)),
        );

  const notePage = useNotePage(
    remote && (view === "notes" || !!needle),
    {
      q: needle,
      tag: noteTag,
      kind: noteType,
      book: noteBook,
      from: dateFrom,
      to: dateTo,
    },
    data,
  );
  const matchedNotes =
    remote && (view === "notes" || !!needle)
      ? notePage.items
      : data.notes.filter(
          (n) =>
            (!needle ||
              [
                n.title,
                n.content,
                ...(n.tags ?? []),
                n.bookId ? booksById.get(n.bookId)?.title : "",
              ]
                .join(" ")
                .toLocaleLowerCase()
                .includes(needle)) &&
            (noteTag === "all" ||
              (noteTag === "untagged"
                ? !(n.tags ?? []).length
                : n.tags?.includes(noteTag))) &&
            (noteType === "all" || n.kind === noteType) &&
            (noteBook === "all" ||
              (noteBook === "unlinked" ? !n.bookId : n.bookId === noteBook)) &&
            (!dateFrom || n.createdAt.slice(0, 10) >= dateFrom) &&
            (!dateTo || n.createdAt.slice(0, 10) <= dateTo),
        );
  const matchedCount = remote ? catalog.total : matchedBooks.length;
  const hasMoreBooks = remote
    ? !!catalog.nextCursor
    : matchedBooks.length > limit;
  const navigate = (next: View) => {
    setView(next);
    setMenuOpen(false);
    setCategory("all");
    setShelfFilter("all");
    setNoteTag("all");
    setNoteType("all");
    setNoteBook("all");
    setDateFrom("");
    setDateTo("");
    setQuery("");
    setFilter("all");
    setLimit(24);
  };
  async function openNote(id: string) {
    if (preview || !remote) {
      const note = data.notes.find((n) => n.id === id);
      if (note) setEditor({ kind: "note", note });
      return;
    }
    try {
      const r = await fetch("/api/notes/" + id, { cache: "no-store" }),
        note = await r.json();
      if (!r.ok) throw Error(note.error);
      setData((d) => ({
        ...d,
        notes: d.notes.map((n) => (n.id === id ? note : n)),
      }));
      setEditor({ kind: "note", note });
    } catch (e) {
      setFailure((e as Error).message);
    }
  }
  async function refresh() {
    const res = await fetch("/api/library", { cache: "no-store" });
    const json = await res.json();
    if (!res.ok) throw Error(json.error || "서재를 불러오지 못했습니다.");
    if (remote && editor?.kind === "note" && editor.note) {
      const r = await fetch("/api/notes/" + editor.note.id, {
        cache: "no-store",
      });
      if (r.ok) {
        const note = await r.json();
        json.notes = json.notes.map((n: Note) => (n.id === note.id ? note : n));
      }
    }
    if (remote && editor && "cycle" in editor) {
      const r = await fetch("/api/reading?id=" + editor.cycle.id, {
        cache: "no-store",
      });
      if (r.ok) {
        const page = await r.json(),
          latest = page.items[0];
        if (latest)
          json.cycles = [
            ...json.cycles.filter((c: ReadingCycle) => c.id !== latest.id),
            latest,
          ];
      }
    }
    setData(json);
    setReadingIndex((index) =>
      Math.min(
        index,
        Math.max(
          0,
          (json as Library).cycles.filter((c) => c.status === "reading")
            .length - 1,
        ),
      ),
    );
  }
  async function save(command: Command) {
    const res = await fetch("/api/library", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command),
    });
    const json = await res.json();
    if (!res.ok) {
      if (res.status === 409) {
        try {
          await refresh();
        } catch {
          /* Keep the editor's unsaved content. */
        }
      }
      throw Object.assign(Error(json.error || "저장하지 못했습니다."), {
        status: res.status,
      });
    }
    try {
      await refresh();
      setMessage(
        json.connectionsReady === false
          ? "서재에 저장했습니다. 연결 후보는 사유의 지도에서 다시 찾을 수 있습니다."
          : "서재에 저장했습니다.",
      );
      setFailure("");
    } catch {
      setMessage(
        "저장은 완료됐습니다. 새로고침하면 최신 기록을 볼 수 있습니다.",
      );
    }
  }
  async function showHistory(id: string) {
    if (preview) {
      setMessage(
        "수정 이력은 내 서재에 저장한 실제 기록에서 확인할 수 있습니다.",
      );
      return;
    }
    try {
      const res = await fetch("/api/revisions/" + id);
      const json = await res.json();
      if (!res.ok) throw Error(json.error);
      setRevisions(json);
    } catch {
      setFailure("수정 이력을 불러오지 못했습니다. 다시 시도해 주세요.");
    }
  }
  const bookCard = (book: Book) => (
    <button
      className="shelf-card"
      key={book.id}
      onClick={() => setDetail(book.id)}
    >
      <div className="book-status-markers" aria-label="독서 상태">
        {completedIds.has(book.id) && (
          <span
            className="status-dot completed"
            title="완독"
            aria-label="완독"
          />
        )}
        {readingIds.has(book.id) && (
          <span
            className="status-dot reading"
            title="읽는 중"
            aria-label="읽는 중"
          />
        )}
        {book.bookshelves?.includes("책 대기열") && (
          <span
            className="status-dot queued"
            title="책 대기열"
            aria-label="책 대기열"
          />
        )}
      </div>
      <BookCover book={book} />
      <CatalogAttribution value={book.enrichment?.catalogSelection} compact />
      <strong>{book.title}</strong>
      <span>{book.author || "저자 미입력"}</span>
      <div className="shelf-meta">
        <span>{book.formats.map((f) => formatNames[f]).join(" · ")}</span>
        <b>
          {readingIds.has(book.id)
            ? "읽는 중"
            : completedIds.has(book.id)
              ? "완독"
              : book.sourceData?.app === "iReadItNow HD"
                ? "독서 상태 확인 필요"
                : "읽기 전"}
        </b>
      </div>
    </button>
  );
  const noteCard = (note: Note) => (
    <article key={note.id} className="note-card">
      <div className="note-meta">
        <span>{kindName[note.kind]}</span>
        <span>{note.updatedAt.slice(0, 10).replaceAll("-", ".")}</span>
      </div>
      <button className="title-button" onClick={() => void openNote(note.id)}>
        <h3>{note.title}</h3>
      </button>
      <p>{note.content}</p>
      <div className="tags note-tags">
        {(note.tags ?? []).map((tag) => (
          <button
            key={tag}
            onClick={() => {
              navigate("notes");
              setNoteTag(tag);
            }}
          >
            #{tag}
          </button>
        ))}
      </div>
      {note.sourceData?.app === "PDF" && (
        <a
          className="text-button"
          href={`/reader/${note.sourceData.recordId}?page=${note.sourceData.raw.pdfPage}&signature=${encodeURIComponent(String(note.sourceData.raw.signature))}`}
          target="_blank"
          rel="noreferrer"
        >
          원문 PDF {String(note.sourceData.raw.pdfPage)}페이지 열기
        </a>
      )}
      <div className="note-source">
        <span>
          {note.bookId
            ? booksById.get(note.bookId)?.title
            : "책 밖에서 떠오른 생각"}
          {note.page ? " · p. " + note.page : ""}
        </span>
        <button
          className="icon-button"
          aria-label={note.title + " 수정 이력"}
          onClick={() => showHistory(note.id)}
        >
          <History size={15} />
        </button>
      </div>
    </article>
  );
  return (
    <div className="app-shell">
      {menuOpen && (
        <NavigationDrawer onClose={() => setMenuOpen(false)}>
          <a className="brand" href={preview ? "/preview" : "/"}>
            <div className="brand-mark">
              <BookOpen size={24} />
            </div>
            <div>
              <strong>문장과 사유</strong>
              <span>나만의 지식 서재</span>
            </div>
          </a>
          <span className="sidebar-caption">MY LIBRARY</span>
          <nav aria-label="주 메뉴">
            {navigation.map((n) => (
              <button
                key={n.id}
                className={view === n.id ? "active" : ""}
                onClick={() => navigate(n.id)}
              >
                <n.icon size={19} />
                <span>{n.label}</span>
                {n.id === "books" && <small>{totalBooks}</small>}
              </button>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <div className="sidebar-quote">
              <Feather size={22} />
              <p>
                책을 읽는 시간은
                <br />
                나를 넓히는 시간.
              </p>
              <span>한 권씩, 오래도록.</span>
            </div>
            <div className="connection-status">
              <CloudCheck size={17} />
              {preview ? "예시 데이터로 둘러보기" : "온라인 서재 연결됨"}
            </div>
            {preview ? (
              <a className="sidebar-login" href="/">
                내 서재 로그인 <ArrowUpRight size={15} />
              </a>
            ) : (
              <button
                className="text-button"
                onClick={async () => {
                  try {
                    const result = await authClient.signOut();
                    if (result.error) throw Error("로그아웃 실패");
                    try {
                      localStorage.removeItem(offlineOwnerKey);
                    } catch {}
                    window.location.assign("/");
                  } catch {
                    setFailure("로그아웃하지 못했습니다. 다시 시도해 주세요.");
                  }
                }}
              >
                <LogOut size={16} />
                로그아웃
              </button>
            )}
          </div>
        </NavigationDrawer>
      )}
      <div className="workspace">
        <header className="topbar">
          <button
            className="icon-button menu-toggle"
            aria-label="메뉴 열기"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(true)}
          >
            <Menu size={24} />
          </button>
          <div className="search-field">
            <Search size={19} />
            <input
              aria-label="서재 검색"
              placeholder="책, 저자, 내 생각을 검색하세요"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setLimit(24);
              }}
            />
            {query && (
              <button
                className="clear-search"
                aria-label="검색 지우기"
                onClick={() => setQuery("")}
              >
                ×
              </button>
            )}
          </div>
          <button
            className="topbar-add secondary"
            onClick={() => setEditor({ kind: "note" })}
          >
            <Plus size={16} />
            <span>기록 남기기</span>
          </button>
          <div className="avatar" aria-label="나의 서재">
            나
          </div>
          {!preview && (
            <button
              className="icon-button mobile-logout"
              aria-label="로그아웃"
              onClick={async () => {
                try {
                  const result = await authClient.signOut();
                  if (result.error) throw Error("로그아웃 실패");
                  try {
                    localStorage.removeItem(offlineOwnerKey);
                  } catch {}
                  window.location.assign("/");
                } catch {
                  setFailure("로그아웃하지 못했습니다. 다시 시도해 주세요.");
                }
              }}
            >
              <LogOut size={16} />
            </button>
          )}
        </header>
        {preview && (
          <div className="preview-banner">
            <span>
              <b>미리보기</b> 가상의 책과 기록으로 구성한 예시 서재입니다.
            </span>
            <a href="/">실제 서재 열기 →</a>
          </div>
        )}
        <main className="main-content">
          <div className="page-heading">
            <div className="heading-line">
              <time className="eyebrow" dateTime={today}>
                {today.replaceAll("-", ".")}
              </time>
              <h1>{navigation.find((n) => n.id === view)?.label}</h1>
            </div>
            <button
              className="primary"
              onClick={() =>
                setEditor(
                  view === "notes" ? { kind: "note" } : { kind: "book" },
                )
              }
            >
              <Plus size={17} />
              {view === "notes" ? "새 기록" : "책 추가"}
            </button>
          </div>
          {(message || failure) && (
            <div
              className={failure ? "error notification" : "notice notification"}
              role={failure ? "alert" : "status"}
            >
              {failure || message}
              <button
                className="text-button"
                onClick={() => {
                  setMessage("");
                  setFailure("");
                }}
              >
                닫기
              </button>
            </div>
          )}
          {view === "books" && (
            <div className="catalog-controls">
              <label>
                분야
                <select
                  aria-label="분야별 소장 도서"
                  value={category}
                  onChange={(e) => {
                    setCategory(e.target.value);
                    setLimit(24);
                  }}
                >
                  <option value="all">전체 분야</option>
                  {categories.map(([id, name]) => (
                    <option key={id} value={id}>
                      {name} · {categoryCount(id)}권
                    </option>
                  ))}
                  <option value="unclassified">
                    미분류 · {categoryCount("")}권
                  </option>
                  <option value="review">분류 검토 필요</option>
                </select>
              </label>
              <label>
                책장
                <select
                  aria-label="책장별 소장 도서"
                  value={shelfFilter}
                  onChange={(e) => {
                    setShelfFilter(e.target.value);
                    setLimit(24);
                  }}
                >
                  <option value="all">모든 책장</option>
                  {[
                    ...new Set([...defaultShelves, ...(data.shelves ?? [])]),
                  ].map((name) => (
                    <option key={name}>{name}</option>
                  ))}
                </select>
              </label>
              <label>
                정렬
                <select
                  aria-label="도서 정렬"
                  value={sort}
                  onChange={(e) => setSort(e.target.value)}
                >
                  <option value="newest">최근 등록한 순</option>
                  <option value="oldest">오래전 등록한 순</option>
                  <option value="title">제목 순</option>
                  <option value="author">저자 이름 순</option>
                </select>
              </label>
            </div>
          )}
          {view === "notes" && (
            <div className="catalog-controls note-controls">
              <NoteTagFilter
                tags={data.notes.flatMap((n) => n.tags ?? [])}
                value={noteTag}
                onChange={(tag) => {
                  setNoteTag(tag);
                  setLimit(24);
                }}
                onUpdated={refresh}
                preview={preview}
              />
              <label>
                종류
                <select
                  value={noteType}
                  onChange={(e) => {
                    setNoteType(e.target.value);
                    setLimit(24);
                  }}
                >
                  <option value="all">모든 기록</option>
                  {Object.entries(kindName).map(([id, name]) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                연결된 책
                <select
                  value={noteBook}
                  onChange={(e) => {
                    setNoteBook(e.target.value);
                    setLimit(24);
                  }}
                >
                  <option value="all">모든 책</option>
                  <option value="unlinked">책과 연결하지 않은 생각</option>
                  {[
                    ...new Set(
                      data.notes.flatMap((n) => (n.bookId ? [n.bookId] : [])),
                    ),
                  ].map((id) => (
                    <option key={id} value={id}>
                      {booksById.get(id)?.title ?? "책"}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                작성일 시작
                <input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                />
              </label>
              <label>
                작성일 끝
                <input
                  type="date"
                  min={dateFrom}
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                />
              </label>
              <span>
                {remote ? notePage.total : matchedNotes.length}개 기록
              </span>
              <button
                className="text-button"
                onClick={() => {
                  setNoteTag("all");
                  setNoteType("all");
                  setNoteBook("all");
                  setDateFrom("");
                  setDateTo("");
                  setQuery("");
                }}
              >
                필터 초기화
              </button>
            </div>
          )}
          {remote && (view === "notes" || needle) && notePage.error && (
            <p role="alert" className="error">
              {notePage.error}
            </p>
          )}
          {remote && view === "notes" && notePage.loading && (
            <p role="status">기록을 불러오는 중…</p>
          )}
          {view === "search" ? (
            <LibrarySearchPanel
              onOpen={(kind, id) => {
                if (kind === "book") setDetail(id);
                else {
                  void openNote(id);
                }
              }}
            />
          ) : needle ? (
            <section data-testid="search-results">
              <div className="section-heading">
                <h2>
                  책 <span className="count">{matchedCount}</span>
                </h2>
              </div>
              <div className="shelf-grid">
                {(remote ? matchedBooks : matchedBooks.slice(0, limit)).map(
                  bookCard,
                )}
              </div>
              <h2 className="section-space">
                기록과 생각{" "}
                <span className="count">
                  {remote ? notePage.total : matchedNotes.length}
                </span>
              </h2>
              <div className="notes-grid">
                {(remote ? matchedNotes : matchedNotes.slice(0, limit)).map(
                  noteCard,
                )}
              </div>
              {!catalog.loading &&
                !matchedBooks.length &&
                !matchedNotes.length && (
                  <div className="empty-state">
                    일치하는 기록이 없습니다. 다른 단어로 찾아보세요.
                  </div>
                )}
            </section>
          ) : (
            <>
              {(view === "home" || view === "stats") && (
                <div className="stat-grid">
                  <div className="stat-card">
                    <span>소장한 책</span>
                    <strong>
                      {totalBooks}
                      <small>권</small>
                    </strong>
                    <p>
                      전자책 {formatCount("ebook")} · 종이책{" "}
                      {formatCount("paper")} · PDF {formatCount("pdf")}
                    </p>
                    <LibraryBig />
                  </div>
                  <div className="stat-card">
                    <span>현재 읽는 중</span>
                    <strong>
                      {currentStats.readingCount}
                      <small>권</small>
                    </strong>
                    <p>저마다의 속도로 읽고 있어요</p>
                    <BookOpen />
                  </div>
                  <div className="stat-card">
                    <span>{Number(month.slice(5))}월 완독</span>
                    <strong data-testid="month-total">
                      {stats.monthCount}
                      <small>권</small>
                    </strong>
                    <p>
                      서로 다른 책 {stats.uniqueBooks}권 · 재독 {stats.rereads}
                      권
                    </p>
                    <CalendarDays />
                  </div>
                  <div className="stat-card">
                    <span>쌓인 기록과 생각</span>
                    <strong>
                      {data.notes.length}
                      <small>개</small>
                    </strong>
                    <p>내 안에 남은 독서의 흔적</p>
                    <Feather />
                  </div>
                </div>
              )}
              {view === "home" && (
                <div className="dashboard-grid">
                  <div className="dashboard-left">
                    <ReadingCarousel
                      index={readingIndex}
                      onIndexChange={setReadingIndex}
                      library={data}
                      onProgress={(cycle) =>
                        setEditor({ kind: "progress", cycle })
                      }
                      onComplete={(cycle) =>
                        setEditor({ kind: "complete", cycle })
                      }
                      onBook={setDetail}
                    />
                    <section className="recent-notes">
                      <div className="section-heading">
                        <div>
                          <span className="eyebrow">WORDS THAT STAY</span>
                          <h2>최근 남긴 생각</h2>
                        </div>
                        <button
                          className="text-button"
                          onClick={() => navigate("notes")}
                        >
                          모두 보기 <ArrowUpRight size={15} />
                        </button>
                      </div>
                      {data.notes.length ? (
                        <div className="notes-grid">
                          {data.notes.slice(0, 2).map(noteCard)}
                        </div>
                      ) : (
                        <div className="panel empty-state">
                          <Feather />
                          <p>책과 상관없이 떠오른 생각도 남겨 보세요.</p>
                          <button
                            className="secondary"
                            onClick={() => setEditor({ kind: "note" })}
                          >
                            첫 생각 남기기
                          </button>
                        </div>
                      )}
                    </section>
                  </div>
                  <ReadingCalendar
                    library={data}
                    month={month}
                    setMonth={setMonth}
                    selected={selected}
                    setSelected={setSelected}
                    onEdit={(cycle) => setEditor({ kind: "date", cycle })}
                    today={today}
                  />
                </div>
              )}
              {view === "books" && (
                <>
                  <div className="book-toolbar">
                    <div
                      className="filter-tabs"
                      role="group"
                      aria-label="도서 보기 방식"
                    >
                      <button
                        aria-pressed={bookLayout === "covers"}
                        onClick={() => chooseBookLayout("covers")}
                      >
                        표지형
                      </button>
                      <button
                        aria-pressed={bookLayout === "list"}
                        onClick={() => chooseBookLayout("list")}
                      >
                        목록형
                      </button>
                    </div>
                    {!preview && (
                      <button onClick={() => setCatalogReviewOpen(true)}>
                        도서정보 검토
                      </button>
                    )}
                    <div className="filter-tabs">
                      {[
                        ["all", "전체"],
                        ["reading", "읽는 중"],
                        ["completed", "완독"],
                        ["paper", "종이책"],
                        ["pdf", "PDF"],
                        ["ebook", "전자책"],
                        ["unknown", "형식 확인 필요"],
                      ].map(([id, label]) => (
                        <button
                          key={id}
                          aria-pressed={filter === id}
                          className={filter === id ? "active" : ""}
                          onClick={() => {
                            setFilter(id);
                            setLimit(24);
                          }}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <span>{matchedCount}권</span>
                  </div>
                  {catalog.loading && !matchedBooks.length ? (
                    <p role="status">도서를 불러오고 있습니다…</p>
                  ) : matchedBooks.length ? (
                    <div
                      className={
                        bookLayout === "covers" ? "shelf-grid" : "book-list"
                      }
                    >
                      {(remote
                        ? matchedBooks
                        : matchedBooks.slice(0, limit)
                      ).map((book) =>
                        bookLayout === "covers" ? (
                          bookCard(book)
                        ) : (
                          <button
                            key={book.id}
                            className="book-list-row"
                            onClick={() => setDetail(book.id)}
                          >
                            <BookCover book={book} />
                            <span className="book-list-description">
                              <strong>{book.title}</strong>
                              <span>
                                {book.author || "저자 미입력"}
                                {book.publisher ? ` · ${book.publisher}` : ""}
                              </span>
                              <small>
                                {book.formats
                                  .map((f) => formatNames[f])
                                  .join(" · ")}
                                {book.category
                                  ? ` · ${categoryName(book.category)}`
                                  : ""}
                              </small>
                            </span>
                            <span className="book-list-status">
                              {readingIds.has(book.id) && (
                                <span className="reading">읽는 중</span>
                              )}
                              {completedIds.has(book.id) && (
                                <span className="completed">완독</span>
                              )}
                              {book.bookshelves?.includes("책 대기열") && (
                                <span className="queued">책 대기열</span>
                              )}
                            </span>
                          </button>
                        ),
                      )}
                    </div>
                  ) : (
                    <div className="panel empty-state">
                      <LibraryBig />
                      <h3>첫 번째 책을 들여놓으세요</h3>
                      <p>
                        서지 정보와 보관 위치를 등록하고 독서 기록을 시작할 수
                        있습니다.
                      </p>
                      <button
                        className="primary"
                        onClick={() => setEditor({ kind: "book" })}
                      >
                        <Plus size={16} />
                        소장 도서 추가
                      </button>
                    </div>
                  )}
                </>
              )}
              {view === "notes" &&
                (data.notes.length ? (
                  <div className="notes-grid">
                    {(remote ? matchedNotes : matchedNotes.slice(0, limit)).map(
                      noteCard,
                    )}
                    {!matchedNotes.length && (
                      <p className="empty-state">
                        조건에 맞는 기록이 없습니다. 필터를 바꾸어 보세요.
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="panel empty-state">
                    <Feather />
                    <p>떠오른 생각을 첫 기록으로 남겨 보세요.</p>
                    <button
                      className="primary"
                      onClick={() => setEditor({ kind: "note" })}
                    >
                      새 기록
                    </button>
                  </div>
                ))}
              {view === "calendar" && (
                <div className="calendar-full">
                  <ReadingCalendar
                    library={data}
                    month={month}
                    setMonth={setMonth}
                    selected={selected}
                    setSelected={setSelected}
                    onEdit={(cycle) => setEditor({ kind: "date", cycle })}
                    today={today}
                  />
                  <div className="panel calendar-summary">
                    <span className="eyebrow">THIS MONTH</span>
                    <h2>{Number(month.slice(5))}월의 독서</h2>
                    <strong>
                      {stats.monthCount}
                      <small>권 완독</small>
                    </strong>
                    <p>
                      서로 다른 책 {stats.uniqueBooks}권<br />
                      다시 읽은 책 {stats.rereads}권
                    </p>
                    <p className="muted">
                      책 표지가 있는 날짜를 눌러 완독한 책을 확인하고 날짜를
                      수정할 수 있습니다.
                    </p>
                  </div>
                </div>
              )}
              {view === "stats" && (
                <section className="panel">
                  <div className="stat-grid">
                    <div className="stat-card">
                      <span>전체 완독 기록</span>
                      <strong>
                        {data.readingSummary?.totalCompleted ??
                          data.cycles.filter((c) => c.status === "completed")
                            .length}
                        <small>권</small>
                      </strong>
                    </div>
                    <div className="stat-card">
                      <span>현재 읽는 책</span>
                      <strong>
                        {readingIds.size}
                        <small>권</small>
                      </strong>
                    </div>
                    <div className="stat-card">
                      <span>{month.slice(0, 4)}년 완독 날짜 기준</span>
                      <strong>
                        {stats.yearCount}
                        <small>권</small>
                      </strong>
                    </div>
                  </div>
                  <div className="section-heading">
                    <div>
                      <span className="eyebrow">A YEAR IN BOOKS</span>
                      <h2>
                        {month.slice(0, 4)}년, {stats.yearCount}권 완독
                      </h2>
                    </div>
                    <label>
                      연도
                      <select
                        aria-label="통계 연도"
                        value={month.slice(0, 4)}
                        onChange={(e) =>
                          setMonth(e.target.value + month.slice(4))
                        }
                      >
                        {[
                          ...new Set([
                            today.slice(0, 4),
                            ...Object.keys(
                              data.readingSummary?.months ?? {},
                            ).map((m) => m.slice(0, 4)),
                            ...data.cycles.flatMap((c) =>
                              c.completedOn ? [c.completedOn.slice(0, 4)] : [],
                            ),
                          ]),
                        ]
                          .sort()
                          .reverse()
                          .map((y) => (
                            <option key={y}>{y}</option>
                          ))}
                      </select>
                    </label>
                  </div>
                  <div className="year-chart">
                    {Array.from({ length: 12 }, (_, i) => {
                      const m =
                        month.slice(0, 4) +
                        "-" +
                        String(i + 1).padStart(2, "0");
                      const n = statsFor(m).monthCount;
                      const max = Math.max(
                        1,
                        ...Array.from(
                          { length: 12 },
                          (_, j) =>
                            statsFor(
                              month.slice(0, 4) +
                                "-" +
                                String(j + 1).padStart(2, "0"),
                            ).monthCount,
                        ),
                      );
                      return (
                        <button
                          key={m}
                          aria-label={m + " 완독 " + n + "권"}
                          className={m === month ? "selected" : ""}
                          onClick={() => setMonth(m)}
                        >
                          <span>{n}</span>
                          <i style={{ height: Math.max(3, (n / max) * 150) }} />
                          <small>{i + 1}월</small>
                        </button>
                      );
                    })}
                  </div>
                  <p className="form-hint">
                    같은 책을 두 번 읽으면 완독 2권으로 집계합니다. 날짜가 없는
                    완독 {stats.undatedCount}권는 월별 통계에서 제외합니다.
                  </p>
                </section>
              )}
              {view === "knowledge" &&
                (preview ? (
                  <p>내 서재에서 책과 생각을 연결해 보세요.</p>
                ) : (
                  <KnowledgePanel
                    library={data}
                    onOpen={(kind, id) => {
                      if (kind === "book") setDetail(id);
                      else {
                        void openNote(id);
                      }
                    }}
                  />
                ))}
              {view === "pdf" &&
                (preview ? (
                  <div className="notice">
                    내 서재에 로그인하면 등록한 PDF를 검색할 수 있습니다.
                  </div>
                ) : (
                  <PdfLibraryPanel onSaved={refresh} />
                ))}
            </>
          )}
          {remote && (view === "books" || needle) && catalog.error && (
            <p role="alert" className="error">
              {catalog.error}{" "}
              <button onClick={catalog.reload}>다시 조회</button>
            </p>
          )}
          {((needle &&
            (hasMoreBooks ||
              (remote
                ? notePage.nextOffset !== null
                : matchedNotes.length > limit))) ||
            (!needle && view === "books" && hasMoreBooks) ||
            (!needle &&
              view === "notes" &&
              (remote
                ? notePage.nextOffset !== null
                : matchedNotes.length > limit))) && (
            <button
              className="secondary load-more"
              disabled={remote && catalog.loading}
              onClick={() => {
                setLimit((n) => n + 24);
                if (remote && (view === "books" || needle)) void catalog.more();
                if (remote && (view === "notes" || needle))
                  void notePage.more();
              }}
            >
              더 보기
            </button>
          )}
          {!preview && ownerId && (
            <OfflineDrafts
              ownerId={ownerId}
              revision={draftRevision}
              onSaved={refresh}
            />
          )}
          {view === "notes" && !preview && (
            <NoteTrash library={data} onSave={save} />
          )}
          <footer className="workspace-footer">
            <span>당신의 책, 당신의 생각.</span>
            <div>
              {!preview && (
                <>
                  <button
                    className="text-button"
                    disabled={refreshing}
                    onClick={async () => {
                      setRefreshing(true);
                      try {
                        await refresh();
                        setMessage("최신 기록을 불러왔습니다.");
                        setFailure("");
                      } catch (e) {
                        setFailure(
                          e instanceof Error ? e.message : "새로고침 실패",
                        );
                      } finally {
                        setRefreshing(false);
                      }
                    }}
                  >
                    <RefreshCw size={14} />
                    {refreshing ? "불러오는 중" : "새로고침"}
                  </button>
                  <button
                    className="text-button"
                    onClick={() => setImporting(true)}
                  >
                    기존 자료 가져오기
                  </button>
                  <a className="text-button" href="/api/export">
                    <Download size={14} />
                    전체 기록 내려받기
                  </a>
                  <button
                    className="text-button"
                    onClick={() => setBackupOpen(true)}
                  >
                    백업과 복원
                  </button>
                </>
              )}
            </div>
          </footer>
        </main>
      </div>
      {importing && (
        <ImportPanel onClose={() => setImporting(false)} onImported={refresh} />
      )}
      {backupOpen && (
        <BackupPanel
          onClose={() => setBackupOpen(false)}
          onRestored={refresh}
        />
      )}
      {editor && (
        <LibraryForm
          key={JSON.stringify(editor)}
          editor={editor}
          library={editorLibrary}
          today={today}
          preview={preview}
          onSave={save}
          onSaveDraft={
            !preview && ownerId && editor.kind === "note"
              ? keepDraft
              : undefined
          }
          onClose={() => setEditor(null)}
        />
      )}
      {catalogReviewOpen && (
        <Modal
          title="도서정보 후보 검토"
          onClose={() => setCatalogReviewOpen(false)}
        >
          <CatalogReviewPanel onChanged={refresh} />
        </Modal>
      )}
      {detail && remote && !detailBook && !editor && (
        <Modal title="책을 펼쳐 보기" onClose={() => setDetail(null)}>
          <p
            className="empty-state"
            role={detailState?.error ? "alert" : "status"}
          >
            {detailState?.error ?? "책 정보를 불러오고 있습니다…"}
          </p>
        </Modal>
      )}
      {detailBook && !editor && (
        <Modal title="책을 펼쳐 보기" onClose={() => setDetail(null)}>
          {detailState?.error && (
            <p role="status" className="notice">
              최신 정보를 불러오지 못했습니다. 다시 열어 주세요.
            </p>
          )}
          <div className="book-detail">
            <BookCover book={detailBook} />
            <div>
              <div className="book-heading-status">
                <span>{categoryName(detailBook.category)}</span>
                {completedIds.has(detailBook.id) && (
                  <span className="status-label completed">완독</span>
                )}
                {readingIds.has(detailBook.id) && (
                  <span className="status-label reading">읽는 중</span>
                )}
              </div>
              <div className="tags">
                {detailBook.tags.map((t) => (
                  <span key={t}>{t}</span>
                ))}
              </div>
              <h2>{detailBook.title}</h2>
              <p>{detailBook.author || "저자 미입력"}</p>
              <dl>
                <dt>출판사</dt>
                <dd>{detailBook.publisher || "미입력"}</dd>
                <dt>ISBN</dt>
                <dd>{detailBook.isbn || "미입력"}</dd>
                <dt>소장 형태</dt>
                <dd>
                  {detailBook.formats.map((f) => formatNames[f]).join(" · ")}
                </dd>
                <dt>분야</dt>
                <dd>{categoryName(detailBook.category)}</dd>
                <dt>보관 위치</dt>
                <dd>{detailBook.shelf || "미입력"}</dd>
              </dl>
            </div>
          </div>
          <CatalogAttribution value={detailBook.enrichment?.catalogSelection} />
          <details className="book-evidence">
            <summary>근거 보기</summary>
            <dl>
              <dt>분류 출처</dt>
              <dd>
                {detailBook.classification?.source ?? "미입력"}
                {detailBook.classification?.verified
                  ? " · 서지 확인됨"
                  : " · 검토 필요"}
              </dd>
              <dt>표지</dt>
              <dd>
                {detailBook.coverUrl
                  ? "외부 서지정보 표지"
                  : detailBook.sourceData?.cover
                    ? "가져온 표지"
                    : detailBook.catalogCoverUrl
                      ? "같은 ISBN으로 확인한 표지"
                      : detailBook.sourceData?.app === "Local PDF"
                        ? "원문 첫 페이지 미리보기 (책 표지와 다를 수 있습니다)"
                        : "제목으로 표시"}
              </dd>
            </dl>
          </details>
          <div className="detail-actions">
            {!readingIds.has(detailBook.id) && (
              <button
                className="primary"
                onClick={() => setEditor({ kind: "start", book: detailBook })}
              >
                {completedIds.has(detailBook.id)
                  ? "다시 읽기 시작"
                  : "읽기 시작"}
              </button>
            )}
            <button
              className="secondary"
              onClick={() => setEditor({ kind: "note", bookId: detailBook.id })}
            >
              기록
            </button>
            <button
              className="secondary"
              onClick={() => setEditor({ kind: "book", book: detailBook })}
            >
              수정
            </button>
          </div>
          <BookShelves
            key={detailBook.id}
            book={detailBook}
            library={data}
            onSave={save}
            preview={preview}
          />
          {!preview && (
            <CurationDetails
              key={detailBook.id + ":curation"}
              kind="book"
              id={detailBook.id}
              onChanged={refresh}
            />
          )}
          {!preview && (
            <BookIntroduction
              key={detailBook.id + ":intro"}
              id={detailBook.id}
            />
          )}
          <PdfIdentityEvidence value={detailBook.enrichment?.pdfIdentity} />
          {!preview && (
            <BookRelations
              key={detailBook.id + ":relations"}
              book={detailBook}
              library={data}
            />
          )}
          {detailBook.sourceData?.app === "Local PDF" && (
            <>
              <a
                className="primary"
                href={`/reader/${detailBook.sourceData.recordId}`}
                target="_blank"
                rel="noreferrer"
              >
                PDF 원문 열기
              </a>
              <PdfLibraryPanel
                documentId={detailBook.sourceData.recordId}
                onSaved={refresh}
              />
            </>
          )}
          {!preview && remote ? (
            <BookRecords
              bookId={detailBook.id}
              onNote={(id) => void openNote(id)}
              onCycle={(cycle) =>
                setEditor({
                  kind: cycle.status === "reading" ? "progress" : "date",
                  cycle,
                })
              }
              revision={data}
            />
          ) : (
            <>
              <h3>독서 이력</h3>
              <div className="cycle-list">
                {data.cycles
                  .filter((c) => c.bookId === detailBook.id)
                  .map((c) => (
                    <div key={c.id}>
                      <span>
                        {c.status === "reading"
                          ? "읽는 중"
                          : c.completedOn + " 완독"}{" "}
                        · {c.currentPage}쪽
                      </span>
                      <button
                        className="text-button"
                        onClick={() =>
                          setEditor({
                            kind: c.status === "reading" ? "progress" : "date",
                            cycle: c,
                          })
                        }
                      >
                        수정
                      </button>
                    </div>
                  ))}
                {!data.cycles.some((c) => c.bookId === detailBook.id) && (
                  <p className="muted">아직 독서 기록이 없습니다.</p>
                )}
              </div>
              <h3>이 책에 남긴 기록</h3>
              {data.notes
                .filter((n) => n.bookId === detailBook.id)
                .map(noteCard)}
            </>
          )}
        </Modal>
      )}
      {revisions && (
        <Modal title="기록의 수정 이력" onClose={() => setRevisions(null)}>
          <p className="form-hint">
            이전 내용을 지우지 않고 변경 당시의 내용을 보관합니다.
          </p>
          {revisions.map((r) => (
            <details className="revision" key={r.id}>
              <summary>
                {new Date(r.createdAt).toLocaleString("ko-KR")} ·{" "}
                {r.action === "deleteNote"
                  ? "휴지통으로 이동"
                  : r.action === "restoreNote"
                    ? "기록 복원"
                    : `${(r.after as { version?: number })?.version ?? ""}번째 저장`}
              </summary>
              {r.before !== null && (
                <>
                  <h4>수정 전</h4>
                  <RevisionContent value={r.before} />
                </>
              )}
              <h4>저장한 내용</h4>
              <RevisionContent value={r.after} />
            </details>
          ))}
        </Modal>
      )}
    </div>
  );
}
