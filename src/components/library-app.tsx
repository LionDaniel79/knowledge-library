"use client";
import { libraryRequest } from "@/client/replica/request";
import type { ModalAnchor } from "@/lib/modal-placement";
import { projectLibrarySave } from "@/client/replica/save-projection";
import { CatalogAttribution } from "./catalog-attribution";
import { AutoBibliographyPanel } from "./auto-bibliography-panel";
import { SyncButton, SyncSummary } from "./replica/sync-button";
import { useReplicaDataOptional } from "./replica/provider";
import { writeStartup } from "@/client/replica/startup-cache";
import { ConflictReviewPanel } from "./replica/conflict-review";
import { OfflineDrafts } from "./offline-drafts";
import { newDraft, writeDraft, offlineOwnerKey } from "@/lib/offline-drafts";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  Menu,
  LibraryBig,
  LayoutDashboard,
  CalendarDays,
  ChartNoAxesCombined,
  Search,
  Plus,
  ArrowUpRight,
  Download,
  LogOut,
  CloudCheck,
  Feather,
  History,
  RefreshCw,
} from "lucide-react";
import {
  readingStats,
  formatNames,
  formats,
  orderedFormats,
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
import { QueuedBooks, RecentCompletedBooks } from "./dashboard-books";
import { ReadingCarousel } from "./reading-carousel";
import { ReadingCalendar } from "./reading-calendar";
import { BookRecommendations } from "./book-recommendations";
import { MonthCompletedBooks } from "./month-completed-books";
import { LibraryForm, type Editor } from "./library-forms";
import { Modal } from "./modal";
import { RevisionContent } from "./revision-content";
import { NavigationDrawer } from "./navigation-drawer";
import { BookShelves } from "./shelf-picker";
import { BookRecords } from "./book-records";
import {
  useListPagination,
  PageSizeSelect,
  PageNavigation,
} from "./list-pagination";

import { CurationDetails } from "./curation-details";
import { BookRelations } from "./book-relations";
import { BookDelete } from "./book-delete";
import { PdfIdentityEvidence } from "./pdf-identity-evidence";
import { PdfStorageLocations } from "./pdf-storage-locations";
import { useBookCatalog } from "./use-book-catalog";
import { categories, categoryName, defaultShelves } from "@/lib/catalog";
import { containsSearchField } from "@/lib/search-fields";
const ImportPanel = lazy(() =>
  import("./import-panel").then((m) => ({ default: m.ImportPanel })),
);
const BackupPanel = lazy(() =>
  import("./backup-panel").then((m) => ({ default: m.BackupPanel })),
);
const SyncSettings = lazy(() =>
  import("./replica/sync-settings").then((m) => ({ default: m.SyncSettings })),
);
const BookExclusions = lazy(() =>
  import("./book-exclusions").then((m) => ({ default: m.BookExclusions })),
);
const CatalogReviewPanel = lazy(() =>
  import("./catalog-review-panel").then((m) => ({
    default: m.CatalogReviewPanel,
  })),
);
const KnowledgePanel = lazy(() =>
  import("./knowledge-panel").then((m) => ({ default: m.KnowledgePanel })),
);
const LibrarySearchPanel = lazy(() =>
  import("./library-search-panel").then((m) => ({
    default: m.LibrarySearchPanel,
  })),
);
type View =
  "home" | "books" | "shelves" | "calendar" | "stats" | "knowledge" | "search";
const navigation = [
  { id: "home", label: "나의 서재", icon: LayoutDashboard },
  { id: "books", label: "소장 도서", icon: LibraryBig },
  { id: "shelves", label: "서재별 보기", icon: LibraryBig },
  { id: "search", label: "통합 검색", icon: Search },
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
  initialView = "home",
  onLibraryView,
}: {
  initial: Library;
  today: string;
  preview?: boolean;
  ownerId?: string;
  initialView?: "home" | "books";
  onLibraryView?: () => void;
}) {
  const replica = useReplicaDataOptional();
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

  const [importing, setImporting] = useState(false);
  const [catalogReviewOpen, setCatalogReviewOpen] = useState(false);
  const [exclusionsOpen, setExclusionsOpen] = useState(false);
  const [backupOpen, setBackupOpen] = useState(false);
  const [syncSettingsOpen, setSyncSettingsOpen] = useState(false);
  const [data, setData] = useState(initial);
  const saveRevision = useRef(0);
  useEffect(() => setData(initial), [initial]);
  useEffect(() => {
    if (preview || !ownerId) return;
    // Let the first frame paint before serializing the small last-opened view.
    const timer = window.setTimeout(() => {
      try {
        if (localStorage.getItem(offlineOwnerKey) === ownerId)
          writeStartup(localStorage, ownerId, data);
      } catch {}
    }, 0);
    return () => window.clearTimeout(timer);
  }, [data, ownerId, preview]);
  const [view, setView] = useState<View>(initialView);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [readingIndex, setReadingIndex] = useState(0);
  const [month, setMonth] = useState(today.slice(0, 7));
  const [selected, setSelected] = useState(today);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [openingNote, setOpeningNote] = useState<{
    id: string;
    anchor?: ModalAnchor;
  } | null>(null);
  const noteRequest = useRef<{
    id: string;
    controller: AbortController;
  } | null>(null);
  useEffect(() => () => noteRequest.current?.controller.abort(), []);
  const [detail, setDetail] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [failure, setFailure] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [revisions, setRevisions] = useState<Revision[] | null>(null);
  const [detailState, setDetailState] = useState<{
    id: string;
    book?: Book;
    error?: string;
    complete?: boolean;
  } | null>(null);
  const remote = !!data.catalog;
  const needle =
    view === "books" || view === "shelves"
      ? query.trim().toLocaleLowerCase()
      : "";
  const bookPaging = useListPagination(
    "books",
    JSON.stringify([view, needle, sort, category, shelfFilter, filter]),
  );

  const catalog = useBookCatalog({
    enabled:
      remote && (view === "books" || view === "shelves") && bookPaging.ready,
    query: {
      q: needle,
      sort,
      category,
      shelf: shelfFilter,
      filter,
      limit: bookPaging.size,
      offset: bookPaging.offset,
    },
    revision: data,
  });
  const totalBooks = data.catalog?.total ?? data.books.length;
  const categoryCount = (id: string) =>
    data.catalog
      ? (data.catalog.categoryCounts[id] ?? 0)
      : data.books.filter((b) => (b.category ?? "") === id).length;
  const formatCount = (format: Format) =>
    data.catalog
      ? (data.catalog.formatCounts[format] ?? 0)
      : data.books.filter((b) => b.formats.includes(format)).length;
  const detailBook = remote
    ? detailState?.id === detail
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
    // Keep the open detail mounted while a changed overview is revalidated.
    // Catalog entries can be partial and must not replace the loaded book.
    setDetailState((previous) => ({
      id: detail,
      book:
        (previous?.id === detail ? previous.book : undefined) ??
        catalog.items.find((b) => b.id === detail) ??
        data.books.find((b) => b.id === detail),
      complete: false,
    }));
    void libraryRequest("/api/books/" + detail, {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (res) => {
        const book = await res.json();
        if (!res.ok)
          throw Error(book.error ?? "책 정보를 불러오지 못했습니다.");
        if (!controller.signal.aborted)
          setDetailState({ id: detail, book, complete: true });
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setDetailState((previous) => ({
            id: detail,
            book: previous?.id === detail ? previous.book : undefined,
            error: e.message,
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
            containsSearchField(
              [
                b.title,
                b.author,
                b.publisher,
                b.isbn,
                b.shelf,
                categoryName(b.category),
                ...(b.bookshelves ?? []),
                ...b.tags,
              ].join(" "),
              needle,
            ) &&
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

  const matchedCount = remote ? catalog.total : matchedBooks.length;
  const navigate = (next: View | "notes") => {
    onLibraryView?.();
    setView(next === "notes" ? "knowledge" : next);
    setMenuOpen(false);
    setCategory("all");
    setShelfFilter("all");
    setNoteTag("all");

    setQuery("");
    setFilter("all");
    bookPaging.setPage(0);
  };
  async function openNote(id: string, anchor?: ModalAnchor) {
    if (preview || !remote) {
      const note = data.notes.find((n) => n.id === id);
      if (note) setEditor({ kind: "note", note, anchor });
      return;
    }
    if (noteRequest.current?.id === id) return;
    noteRequest.current?.controller.abort();
    const controller = new AbortController();
    noteRequest.current = { id, controller };
    setOpeningNote({ id, anchor });
    try {
      const r = await libraryRequest("/api/notes/" + id, {
          cache: "no-store",
          signal: controller.signal,
        }),
        note = await r.json();
      if (controller.signal.aborted) return;
      if (!r.ok) throw Error(note.error);
      setData((d) => ({
        ...d,
        notes: d.notes.map((n) => (n.id === id ? note : n)),
      }));
      setEditor({ kind: "note", note, anchor });
    } catch (e) {
      if (!controller.signal.aborted) setFailure((e as Error).message);
    } finally {
      if (noteRequest.current?.controller === controller) {
        noteRequest.current = null;
        setOpeningNote(null);
      }
    }
  }
  async function refresh() {
    const revision = saveRevision.current;
    const res = await libraryRequest("/api/library", { cache: "no-store" });
    const json = await res.json();
    if (!res.ok) throw Error(json.error || "서재를 불러오지 못했습니다.");
    if (remote && editor?.kind === "note" && editor.note) {
      const r = await libraryRequest("/api/notes/" + editor.note.id, {
        cache: "no-store",
      });
      if (r.ok) {
        const note = await r.json();
        json.notes = json.notes.map((n: Note) => (n.id === note.id ? note : n));
      }
    }
    if (remote && editor && "cycle" in editor) {
      const r = await libraryRequest("/api/reading?id=" + editor.cycle.id, {
        cache: "no-store",
      });
      if (r.ok) {
        const page = await r.json(),
          latest = page.items[0];
        if (latest)
          json.cycles = json.cycles.some(
            (c: ReadingCycle) => c.id === latest.id,
          )
            ? json.cycles.map((c: ReadingCycle) =>
                c.id === latest.id ? latest : c,
              )
            : [...json.cycles, latest];
      }
    }
    if (revision !== saveRevision.current) return;
    setData(
      replica && !replica.ready
        ? await replica.runtime.withPendingReading(json)
        : json,
    );
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
    if (
      ["updateProgress", "completeReading", "editCompletion"].includes(
        command.type,
      )
    ) {
      const p = command.payload as {
        id: string;
        currentPage: number;
        expectedVersion: number;
      };
      const cycle = data.cycles.find((c) => c.id === p.id),
        book = data.books.find((b) => b.id === cycle?.bookId);
      if (replica && cycle && book) {
        const result = await replica.runtime.queue("/api/library", command, {
          cycle,
          book,
        });
        saveRevision.current++;
        setData((d) => projectLibrarySave(d, command, result));
        setMessage("기기에 저장했습니다. 동기화는 뒤에서 진행합니다.");
        setFailure("");
        return;
      }
    }
    const res = await libraryRequest("/api/library", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command),
    });
    const json = await res.json();
    if (!res.ok) {
      if (res.status === 409) {
        void refresh().catch(() => {});
      }
      throw Object.assign(Error(json.error || "저장하지 못했습니다."), {
        status: res.status,
      });
    }
    try {
      saveRevision.current++;
      setData((d) => projectLibrarySave(d, command, json));
      // A durable commit releases the form; catalog refresh is independent.
      if (command.type !== "updateProgress") void refresh().catch(() => {});
      setMessage(
        json.queued
          ? "기기에 저장했습니다. 연결되면 동기화합니다."
          : command.type === "emptyNoteTrash"
            ? "휴지통의 기록을 영구 삭제했습니다."
            : json.connectionsReady === false
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
      const res = await libraryRequest("/api/revisions/" + id);
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
      <CatalogAttribution
        value={book.enrichment?.catalogSelection}
        automatic={book.enrichment}
        compact
      />
      <strong>{book.title}</strong>
      <span>{book.author || "저자 미입력"}</span>
      <div className="shelf-meta">
        <span>
          {orderedFormats(book.formats)
            .map((f) => formatNames[f])
            .join(" · ")}
        </span>
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
    <article
      key={note.id}
      className="note-card"
      onClick={(event) => {
        if (
          !(event.target as Element).closest(
            "button,a,input,select,textarea,summary",
          ) &&
          !window.getSelection()?.toString()
        )
          void openNote(note.id);
      }}
    >
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
        <span>PDF {String(note.sourceData.raw.pdfPage)}페이지</span>
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
              {preview
                ? "예시 데이터로 둘러보기"
                : replica?.ready
                  ? "기기 서재"
                  : "온라인 서재 연결됨"}
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
          <button
            className="topbar-add secondary"
            aria-label="새 기록"
            aria-haspopup="dialog"
            onClick={() => setEditor({ kind: "note" })}
          >
            <Plus size={16} />
            <span>새 기록</span>
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
            <div className="heading-actions">
              {!preview && (
                <SyncButton onError={(e) => setFailure(e.message)} />
              )}
              {(view === "home" || view === "books") && (
                <button
                  className="primary"
                  onClick={() => setEditor({ kind: "book" })}
                >
                  <Plus size={17} />책 추가
                </button>
              )}
              {!preview && <SyncSummary />}
            </div>
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
          {(view === "books" || view === "shelves") && (
            <div className="catalog-controls">
              <label>
                분야
                <select
                  aria-label="분야별 소장 도서"
                  value={category}
                  onChange={(e) => {
                    setCategory(e.target.value);
                    bookPaging.setPage(0);
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
                    bookPaging.setPage(0);
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
                검색
                <input
                  type="search"
                  aria-label="소장 도서 검색"
                  placeholder="제목·저자·출판사·ISBN"
                  value={query}
                  maxLength={200}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    bookPaging.setPage(0);
                  }}
                />
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

          {view === "search" ? (
            <Suspense fallback={<p role="status">화면을 여는 중…</p>}>
              <LibrarySearchPanel
                library={data}
                ownerId={ownerId}
                preview={preview}
                onUpdated={refresh}
                renderBook={bookCard}
                renderNote={noteCard}
                onOpen={(kind, id) => {
                  if (kind === "book") setDetail(id);
                  else {
                    void openNote(id);
                  }
                }}
              />
            </Suspense>
          ) : (
            <>
              {(view === "home" || view === "stats") && (
                <div className="stat-grid">
                  <button
                    type="button"
                    className="stat-card"
                    aria-label="소장한 책"
                    style={{
                      textAlign: "left",
                      color: "inherit",
                      width: "100%",
                    }}
                    onClick={() => navigate("books")}
                  >
                    <span>소장한 책</span>
                    <strong>
                      {totalBooks}
                      <small>권</small>
                    </strong>
                    <p>
                      {formats
                        .map(
                          (format) =>
                            `${formatNames[format]} ${formatCount(format)}`,
                        )
                        .join(" · ")}
                    </p>
                    <LibraryBig />
                  </button>
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
                    <span>쌓인 내 기록</span>
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
                <>
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
                    <BookRecommendations
                      excludedBookIds={[
                        ...(data.readingSummary?.completedIds ?? []),
                        ...data.cycles
                          .filter(
                            (c) =>
                              c.status === "completed" ||
                              c.status === "reading",
                          )
                          .map((c) => c.bookId),
                      ]}
                      revision={data}
                      ownerId={ownerId}
                      onOpenBook={setDetail}
                    />
                  </div>
                  <QueuedBooks library={data} renderBook={bookCard} />
                  <RecentCompletedBooks
                    library={data}
                    today={today}
                    renderBook={bookCard}
                  />
                </>
              )}
              {(view === "books" || view === "shelves") && (
                <>
                  <div className="book-toolbar">
                    <div className="book-view-actions">
                      <PageSizeSelect label="소장 도서" paging={bookPaging} />
                      <div className="book-view-review">
                        <select
                          aria-label="도서 보기 방식"
                          value={bookLayout}
                          onChange={(e) =>
                            chooseBookLayout(
                              e.target.value === "list" ? "list" : "covers",
                            )
                          }
                        >
                          <option value="list">목록형</option>
                          <option value="covers">표지형</option>
                        </select>
                        {!preview && (
                          <button onClick={() => setCatalogReviewOpen(true)}>
                            도서정보 검토
                          </button>
                        )}
                      </div>
                      {!preview && (
                        <button
                          className="secondary"
                          onClick={() => setExclusionsOpen(true)}
                        >
                          삭제·제외한 자료
                        </button>
                      )}
                    </div>
                    <div className="filter-tabs">
                      {[
                        ["all", "전체"],
                        ["reading", "읽는 중"],
                        ["completed", "완독"],
                        ...formats.map((format) => [
                          format,
                          formatNames[format],
                        ]),
                      ].map(([id, label]) => (
                        <button
                          key={id}
                          aria-pressed={filter === id}
                          className={filter === id ? "active" : ""}
                          onClick={() => {
                            setFilter(id);
                            bookPaging.setPage(0);
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
                        : matchedBooks.slice(
                            bookPaging.offset,
                            bookPaging.offset + bookPaging.size,
                          )
                      ).map((book) =>
                        bookLayout === "covers" ? (
                          bookCard(book)
                        ) : (
                          <button
                            key={book.id}
                            className="book-list-row"
                            onClick={() => setDetail(book.id)}
                          >
                            <BookCover book={book} small />
                            <span className="book-list-description">
                              <strong>{book.title}</strong>
                              <span>
                                {book.author || "저자 미입력"}
                                {book.publisher ? ` · ${book.publisher}` : ""}
                              </span>
                              <small>
                                {orderedFormats(book.formats)
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
                      <h3>
                        {shelfFilter !== "all"
                          ? "이 서재에 담긴 책이 없습니다"
                          : "첫 번째 책을 들여놓으세요"}
                      </h3>
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

              {view === "calendar" && (
                <div className="calendar-full">
                  <ReadingCalendar
                    library={data}
                    month={month}
                    setMonth={setMonth}
                    selected={selected}
                    setSelected={setSelected}
                    onEdit={(cycle) => setEditor({ kind: "date", cycle })}
                    onOpenBook={setDetail}
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
                            month.slice(0, 4),
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
                  <MonthCompletedBooks
                    library={data}
                    month={month}
                    onOpenBook={setDetail}
                  />
                </section>
              )}
              {view === "knowledge" &&
                (preview ? (
                  <p>내 서재에서 책과 생각을 연결해 보세요.</p>
                ) : (
                  <Suspense fallback={<p role="status">화면을 여는 중…</p>}>
                    <KnowledgePanel
                      initialTag={noteTag}
                      ownerId={ownerId}
                      onUpdated={refresh}
                      onSaveNote={save}
                      onNewNote={(context) =>
                        setEditor({ kind: "note", ...context })
                      }
                      library={data}
                      onOpen={(kind, id, anchor) => {
                        if (kind === "book") setDetail(id);
                        else {
                          void openNote(id, anchor);
                        }
                      }}
                    />
                  </Suspense>
                ))}
            </>
          )}
          {remote &&
            (view === "books" || view === "shelves") &&
            catalog.error && (
              <p role="alert" className="error">
                {catalog.error}{" "}
                <button onClick={catalog.reload}>다시 조회</button>
              </p>
            )}
          {(view === "books" || view === "shelves") && (
            <PageNavigation
              label="소장 도서"
              paging={bookPaging}
              total={matchedCount}
              busy={catalog.loading || !!catalog.error}
            />
          )}

          {!preview && ownerId && (
            <OfflineDrafts
              ownerId={ownerId}
              revision={draftRevision}
              onSaved={refresh}
            />
          )}
          {!preview && <ConflictReviewPanel />}

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
                  <button
                    className="text-button"
                    onClick={() => setSyncSettingsOpen(true)}
                  >
                    기기 저장·동기화
                  </button>
                  <a className="text-button" href="/desktop/connect">
                    Windows PDF 서재 연결
                  </a>
                  <a className="text-button" href="/logos/import">
                    로고스 도서 가져오기
                  </a>
                </>
              )}
            </div>
          </footer>
        </main>
      </div>
      {importing && (
        <Suspense fallback={<p role="status">화면을 여는 중…</p>}>
          <ImportPanel
            onClose={() => setImporting(false)}
            onImported={refresh}
          />
        </Suspense>
      )}
      {backupOpen && (
        <Suspense fallback={<p role="status">화면을 여는 중…</p>}>
          <BackupPanel
            onClose={() => setBackupOpen(false)}
            onRestored={refresh}
          />
        </Suspense>
      )}
      {syncSettingsOpen && (
        <Suspense fallback={<p role="status">화면을 여는 중…</p>}>
          <SyncSettings
            onClose={() => setSyncSettingsOpen(false)}
            onError={(error) => setFailure(error.message)}
          />
        </Suspense>
      )}
      {openingNote && (
        <Modal
          title="기록 불러오기"
          className={openingNote.anchor ? "memo-editor wb-memo-editor" : ""}
          anchor={openingNote.anchor}
          onClose={() => {
            noteRequest.current?.controller.abort();
            noteRequest.current = null;
            setOpeningNote(null);
          }}
        >
          <p role="status">기록을 불러오는 중…</p>
        </Modal>
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
      {exclusionsOpen && (
        <Suspense fallback={<p role="status">화면을 여는 중…</p>}>
          <BookExclusions
            onClose={() => setExclusionsOpen(false)}
            onChanged={refresh}
          />
        </Suspense>
      )}
      {catalogReviewOpen && (
        <Modal
          title="도서정보 후보 검토"
          onClose={() => setCatalogReviewOpen(false)}
        >
          <Suspense fallback={<p role="status">화면을 여는 중…</p>}>
            <CatalogReviewPanel onChanged={refresh} />
          </Suspense>
        </Modal>
      )}
      {detail && remote && !detailBook && !editor && (
        <Modal
          className="book-detail-modal"
          title="책을 펼쳐 보기"
          onClose={() => setDetail(null)}
        >
          <p
            className="empty-state"
            role={detailState?.error ? "alert" : "status"}
          >
            {detailState?.error ?? "책 정보를 불러오고 있습니다…"}
          </p>
        </Modal>
      )}
      {detailBook && !editor && (
        <Modal
          className="book-detail-modal"
          title="책을 펼쳐 보기"
          onClose={() => setDetail(null)}
        >
          {detailState?.error && (
            <p role="status" className="notice">
              최신 정보를 불러오지 못했습니다. 다시 열어 주세요.
            </p>
          )}
          <div className="book-detail">
            <div>
              <BookCover book={detailBook} />
              <button
                className="secondary"
                onClick={() =>
                  setEditor({
                    kind: "book",
                    book: detailBook,
                    focusCover: true,
                  })
                }
              >
                표지 수정
              </button>
            </div>
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
                  {orderedFormats(detailBook.formats)
                    .map((f) => formatNames[f])
                    .join(" · ")}
                </dd>
                <dt>분야</dt>
                <dd>{categoryName(detailBook.category)}</dd>
                <dt>보관 위치</dt>
                <dd>{detailBook.shelf || "미입력"}</dd>
              </dl>
            </div>
          </div>
          <CatalogAttribution
            value={detailBook.enrichment?.catalogSelection}
            automatic={detailBook.enrichment}
          />
          {!preview && (
            <AutoBibliographyPanel
              key={detailBook.id + ":auto-bibliography"}
              bookId={detailBook.id}
              onChanged={refresh}
            />
          )}
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
              disabled={remote && !detailState?.complete}
              onClick={() => setEditor({ kind: "book", book: detailBook })}
            >
              수정
            </button>
            {!preview && (
              <BookDelete
                key={detailBook.id + ":delete"}
                book={detailBook}
                disabled={remote && !detailState?.complete}
                onConflict={() => {
                  void refresh().catch(() => {});
                }}
                onDeleted={(queued) => {
                  saveRevision.current++;
                  setDetail(null);
                  setMessage(
                    queued
                      ? "이 기기에 도서 삭제를 저장했습니다. 연결되면 동기화됩니다."
                      : "소장 도서에서 삭제했습니다. 삭제·제외한 자료에서 복원할 수 있습니다.",
                  );
                  setFailure("");
                  setData((current) => ({
                    ...current,
                    books: current.books.filter(
                      (book) => book.id !== detailBook.id,
                    ),
                    cycles: current.cycles.filter(
                      (cycle) => cycle.bookId !== detailBook.id,
                    ),
                  }));
                  void refresh().catch(() =>
                    setFailure(
                      "삭제했습니다. 서재를 새로고침하면 목록에 반영됩니다.",
                    ),
                  );
                }}
              />
            )}
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
          <PdfIdentityEvidence value={detailBook.enrichment?.pdfIdentity} />
          <PdfStorageLocations book={detailBook} />
          {!preview && (
            <BookRelations
              key={detailBook.id + ":relations"}
              book={detailBook}
              library={data}
            />
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
