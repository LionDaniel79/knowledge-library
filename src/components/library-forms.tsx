"use client";
import { useRef, useState, type FormEvent } from "react";
import type { Book, Command, Library, Note, ReadingCycle } from "@/lib/domain";
import { BookLookup } from "./book-lookup";
import type { BookCandidate } from "@/lib/book-lookup";
import { CoverInput } from "./cover-input";
import { Modal } from "./modal";
import { categories, parseTags } from "@/lib/catalog";
import { ShelfPicker } from "./shelf-picker";
import { CurationDetails } from "./curation-details";
import { BookPicker } from "./book-picker";
import { useBookCatalog } from "./use-book-catalog";
import { AssistLauncher } from "./assist-panel";
export type Editor =
  | { kind: "book"; book?: Book }
  | { kind: "note"; note?: Note; bookId?: string }
  | { kind: "start"; book: Book }
  | { kind: "progress" | "complete" | "date"; cycle: ReadingCycle };
export function LibraryForm({
  editor,
  library,
  today,
  preview,
  onClose,
  onSave,
  onSaveDraft,
}: {
  editor: Editor;
  library: Library;
  today: string;
  preview: boolean;
  onClose: () => void;
  onSave: (c: Command) => Promise<void>;
  onSaveDraft?: (c: Command) => Promise<void>;
}) {
  const verifiedQuote =
    editor.kind === "note" && editor.note?.sourceData?.app === "PDF";
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const book = editor.kind === "book" ? editor.book : undefined;
  const [shelves, setShelves] = useState(book?.bookshelves ?? []);
  const [coverUrl, setCoverUrl] = useState(book?.coverUrl ?? "");
  const [uploading, setUploading] = useState(false);
  const [isbn, setIsbn] = useState(book?.isbn ?? "");
  const [title, setTitle] = useState(book?.title ?? "");
  const formRef = useRef<HTMLFormElement>(null);
  const [selectedCatalog, setSelectedCatalog] = useState<BookCandidate | null>(
    null,
  );
  const pending = useRef<{ signature: string; id: string } | null>(null);
  const [noteKind, setNoteKind] = useState(
    editor.kind === "note" ? (editor.note?.kind ?? "thought") : "thought",
  );
  const [conflict, setConflict] = useState(false);
  const [baseVersion, setBaseVersion] = useState<number | null>(null);
  const latest = book
    ? library.books.find((b) => b.id === book.id)
    : editor.kind === "note" && editor.note
      ? library.notes.find((n) => n.id === editor.note!.id)
      : "cycle" in editor
        ? library.cycles.find((c) => c.id === editor.cycle.id)
        : undefined;
  const originalVersion = book
    ? book.version
    : editor.kind === "note"
      ? editor.note?.version
      : "cycle" in editor
        ? editor.cycle.version
        : undefined;
  const heading = {
    book: book ? "책 정보 수정" : "소장 도서 추가",
    note: editor.kind === "note" && editor.note ? "기록 수정" : "새로운 기록",
    start: "읽기 시작",
    progress: "읽은 쪽 기록",
    complete: "한 권을 다 읽었습니다",
    date: "완독 날짜 수정",
  }[editor.kind];
  const duplicateLookup = useBookCatalog({
    enabled:
      !!library.catalog &&
      editor.kind === "book" &&
      !!(isbn.trim() || title.trim()),
    query: { q: isbn.trim() || title.trim(), sort: "title" },
    revision: library,
  });
  const duplicates =
    editor.kind === "book"
      ? (library.catalog ? duplicateLookup.items : library.books).filter(
          (b) =>
            b.id !== book?.id &&
            (isbn.trim()
              ? b.isbn.replace(/[- ]/g, "") === isbn.replace(/[- ]/g, "")
              : title.trim() && b.title === title.trim()),
        )
      : [];
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (uploading) return;
    if (preview) {
      setError(
        "미리보기에서는 저장하지 않습니다. 내 서재에 로그인하면 사용할 수 있습니다.",
      );
      return;
    }
    const f = new FormData(e.currentTarget);
    const text = (name: string) => String(f.get(name) || "").trim();
    const number = (name: string) => (text(name) ? Number(text(name)) : null);
    let type: string;
    let payload: unknown;
    if (editor.kind === "book") {
      type = book ? "editBook" : "addBook";
      payload = {
        title: text("title"),
        author: text("author"),
        publisher: text("publisher"),
        isbn: text("isbn"),
        totalPages: number("totalPages"),
        shelf: text("shelf"),
        category: text("category"),
        bookshelves: shelves,
        coverUrl: text("coverUrl"),
        ...(selectedCatalog
          ? {
              catalogSelection: {
                provider: selectedCatalog.provider,
                sourceUrl: selectedCatalog.sourceUrl,
                description: selectedCatalog.description,
              },
            }
          : {}),
        ...(book
          ? { id: book.id, expectedVersion: baseVersion ?? book.version }
          : {}),
        formats: f.getAll("formats"),
        tags: text("tags")
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      };
    } else if (editor.kind === "note") {
      type = editor.note ? "editNote" : "addNote";
      payload = {
        bookId: text("bookId") || null,
        title: text("title"),
        content: text("content"),
        kind: text("kind"),
        page: number("page"),
        tags: parseTags(text("tags")),
        ...(editor.note
          ? {
              id: editor.note.id,
              expectedVersion: baseVersion ?? editor.note.version,
            }
          : {}),
      };
    } else if (editor.kind === "start") {
      type = "startReading";
      payload = { bookId: editor.book.id, startedOn: text("date") || null };
    } else {
      type =
        editor.kind === "progress"
          ? "updateProgress"
          : editor.kind === "complete"
            ? "completeReading"
            : "editCompletion";
      payload = {
        id: editor.cycle.id,
        expectedVersion: baseVersion ?? editor.cycle.version,
        ...(editor.kind === "progress"
          ? { currentPage: number("currentPage") ?? 0 }
          : { completedOn: text("date") }),
      };
    }
    const signature = JSON.stringify({ type, payload });
    if (pending.current?.signature !== signature)
      pending.current = { signature, id: crypto.randomUUID() };
    setBusy(true);
    setError("");
    try {
      const command = { type, payload, requestId: pending.current.id };
      if (
        (e.nativeEvent as SubmitEvent).submitter?.getAttribute("value") ===
          "draft" &&
        onSaveDraft
      )
        await onSaveDraft(command);
      else await onSave(command);
      onClose();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "저장하지 못했습니다. 내용을 확인하고 다시 시도해 주세요.",
      );
      if ((e as { status?: number }).status === 409 && originalVersion)
        setConflict(true);
    } finally {
      setBusy(false);
    }
  }
  async function deleteNote() {
    if (preview || busy || editor.kind !== "note" || !editor.note) return;
    const type = "deleteNote",
      payload = {
        id: editor.note.id,
        expectedVersion: baseVersion ?? editor.note.version,
      };
    const signature = JSON.stringify({ type, payload });
    if (pending.current?.signature !== signature)
      pending.current = { signature, id: crypto.randomUUID() };
    setBusy(true);
    setError("");
    try {
      await onSave({ type, payload, requestId: pending.current.id });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "삭제하지 못했습니다.");
      if ((e as { status?: number }).status === 409) setConflict(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={heading}
      canClose={!busy}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form ref={formRef} className="editor-form" onSubmit={submit}>
        <fieldset className="editor-fields" disabled={busy}>
          {preview && (
            <div className="notice">
              예시 화면입니다. 입력을 살펴볼 수 있으며 실제 서재에는 저장되지
              않습니다.
            </div>
          )}
          {editor.kind === "book" && !book && (
            <BookLookup
              preview={preview}
              onSelect={(candidate) => {
                setIsbn(candidate.isbn);
                setTitle(candidate.title);
                setCoverUrl(candidate.coverUrl);
                setSelectedCatalog(candidate);
                for (const [name, value] of Object.entries({
                  title: candidate.title,
                  author: candidate.author,
                  publisher: candidate.publisher,
                  totalPages: candidate.totalPages ?? "",
                  category: candidate.category ?? "",
                })) {
                  const field = formRef.current?.elements.namedItem(name);
                  if (
                    field instanceof HTMLInputElement ||
                    field instanceof HTMLSelectElement
                  )
                    field.value = String(value);
                }
              }}
            />
          )}
          {editor.kind === "book" && (
            <>
              <label>
                책 제목 <span>*</span>
                <input
                  name="title"
                  required
                  maxLength={300}
                  placeholder="내 서재에 놓을 책"
                  defaultValue={book?.title}
                  autoFocus
                  onChange={(e) => setTitle(e.target.value)}
                />
              </label>
              <div className="form-row">
                <label>
                  저자
                  <input
                    name="author"
                    maxLength={300}
                    defaultValue={book?.author}
                  />
                </label>
                <label>
                  출판사
                  <input
                    name="publisher"
                    maxLength={300}
                    defaultValue={book?.publisher}
                  />
                </label>
              </div>
              <div className="form-row">
                <label>
                  ISBN
                  <input
                    name="isbn"
                    maxLength={30}
                    value={isbn}
                    onChange={(e) => setIsbn(e.target.value)}
                    placeholder="확인된 번호만 입력"
                  />
                  <small>판본에 인쇄된 ISBN을 기록해 주세요.</small>
                </label>
                <label>
                  전체 쪽수
                  <input
                    name="totalPages"
                    defaultValue={book?.totalPages ?? ""}
                    type="number"
                    min={1}
                    max={100000}
                  />
                </label>
              </div>
              <fieldset>
                <legend>소장 형태</legend>
                <label className="check-label">
                  <input
                    name="formats"
                    type="checkbox"
                    value="ebook"
                    defaultChecked={book?.formats.includes("ebook")}
                  />
                  전자책
                </label>
                <label className="check-label">
                  <input
                    name="formats"
                    type="checkbox"
                    value="paper"
                    defaultChecked={
                      book ? book.formats.includes("paper") : true
                    }
                  />
                  종이책
                </label>
                <label className="check-label">
                  <input
                    name="formats"
                    type="checkbox"
                    value="pdf"
                    defaultChecked={book?.formats.includes("pdf")}
                  />
                  PDF
                </label>
                <label className="check-label">
                  <input
                    name="formats"
                    type="checkbox"
                    value="unknown"
                    defaultChecked={book?.formats.includes("unknown")}
                  />
                  형식 확인 필요
                </label>
              </fieldset>
              <label>
                보관 위치
                <input
                  name="shelf"
                  defaultValue={book?.shelf}
                  maxLength={300}
                  placeholder="예: 서재 A-2 · 외장하드 / 철학"
                />
              </label>
              <label>
                주제
                <input
                  name="tags"
                  placeholder="쉼표로 구분: 신학, 철학, 상담"
                  defaultValue={book?.tags.join(", ")}
                />
              </label>
              <label>
                책 분야
                <select name="category" defaultValue={book?.category ?? ""}>
                  <option value="">미분류</option>
                  {categories.map(([id, name]) => (
                    <option key={id} value={id}>
                      {name} ({id})
                    </option>
                  ))}
                </select>
              </label>
              <CoverInput
                value={coverUrl}
                onChange={setCoverUrl}
                preview={preview}
                onBusy={setUploading}
              />
              <ShelfPicker
                library={library}
                selected={shelves}
                onChange={setShelves}
                onSave={onSave}
                preview={preview}
              />
              {!!duplicates.length && (
                <div className="notice">
                  이미 소장한 책일 수 있습니다:{" "}
                  {duplicates.map((b) => b.title).join(", ")}. 다른 판본인지
                  확인해 주세요. 자동으로 합치지 않습니다.
                </div>
              )}
            </>
          )}
          {editor.kind === "note" && (
            <>
              {editor.note?.sourceData?.app === "PDF" && (
                <p className="notice">
                  확인한 원문 인용은 보존됩니다. 제목과 태그를 수정할 수 있으며,
                  해석은 새 메모에 남겨 주세요.
                </p>
              )}
              <label>
                제목
                <input
                  name="title"
                  required
                  maxLength={300}
                  defaultValue={editor.note?.title}
                  placeholder="지금 남겨 두고 싶은 생각"
                  autoFocus
                />
              </label>
              {verifiedQuote && editor.kind === "note" && (
                <>
                  <input type="hidden" name="kind" value={editor.note!.kind} />
                  <input
                    type="hidden"
                    name="bookId"
                    value={editor.note!.bookId ?? ""}
                  />
                </>
              )}
              <div className="form-row">
                <label>
                  기록의 종류
                  <select
                    name="kind"
                    disabled={verifiedQuote}
                    value={noteKind}
                    onChange={(e) =>
                      setNoteKind(e.target.value as Note["kind"])
                    }
                  >
                    <option value="thought">나의 생각</option>
                    <option value="claim">주장</option>
                    <option value="evidence">근거</option>
                    <option value="counterargument">반론</option>
                    <option value="reflection">생각의 변화</option>
                    <option value="note">독서 메모</option>
                    <option value="review">서평</option>
                    <option value="highlight">원문 하이라이트</option>
                  </select>
                </label>
                <label>
                  원문 쪽수
                  <input
                    name="page"
                    readOnly={verifiedQuote}
                    type="number"
                    min={1}
                    required={noteKind === "highlight"}
                    defaultValue={editor.note?.page ?? ""}
                  />
                </label>
              </div>
              {library.catalog ? (
                <BookPicker
                  library={library}
                  defaultValue={editor.note?.bookId ?? editor.bookId ?? ""}
                  disabled={verifiedQuote}
                  required={noteKind === "highlight"}
                />
              ) : (
                <label>
                  연결할 책
                  <select
                    name="bookId"
                    disabled={verifiedQuote}
                    required={noteKind === "highlight"}
                    defaultValue={editor.note?.bookId ?? editor.bookId ?? ""}
                  >
                    <option value="">책과 연결하지 않은 생각</option>
                    {library.books.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.title}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label>
                태그
                <input
                  name="tags"
                  maxLength={800}
                  defaultValue={editor.note?.tags?.join(", ") ?? ""}
                  placeholder="쉼표로 구분: 관계, 감정, 신앙"
                  list="note-tag-options"
                />
              </label>
              <datalist id="note-tag-options">
                {[...new Set(library.notes.flatMap((n) => n.tags ?? []))].map(
                  (t) => (
                    <option key={t} value={t} />
                  ),
                )}
              </datalist>
              <label>
                내용
                <textarea
                  name="content"
                  readOnly={verifiedQuote}
                  required
                  rows={7}
                  maxLength={50000}
                  defaultValue={editor.note?.content}
                  placeholder="책에서 만난 문장과 나의 생각을 구분해 남겨 보세요."
                />
              </label>
              <p className="form-hint">
                하이라이트는 직접 확인한 원문과 쪽수를 입력합니다. 수정해도 이전
                내용은 이력에 남습니다.
              </p>
            </>
          )}
          {editor.kind === "start" && (
            <>
              <p>
                <strong>{editor.book.title}</strong>의 새로운 독서 회차를
                시작합니다.
              </p>
              <label>
                읽기 시작한 날
                <input name="date" type="date" defaultValue={today} />
              </label>
              <p className="form-hint">
                재독을 시작해도 이전 완독 기록은 유지됩니다.
              </p>
            </>
          )}
          {editor.kind === "progress" && (
            <label>
              현재 읽은 쪽수
              <input
                name="currentPage"
                type="number"
                min={0}
                max={
                  library.books.find((b) => b.id === editor.cycle.bookId)
                    ?.totalPages ?? 100000
                }
                defaultValue={editor.cycle.currentPage}
                required
                autoFocus
              />
            </label>
          )}
          {(editor.kind === "complete" || editor.kind === "date") && (
            <>
              <p>
                {library.books.find((b) => b.id === editor.cycle.bookId)?.title}
              </p>
              <label>
                완독한 날
                <input
                  name="date"
                  type="date"
                  min={editor.cycle.startedOn ?? undefined}
                  defaultValue={editor.cycle.completedOn ?? today}
                  required
                />
              </label>
              <p className="form-hint">
                선택한 날짜의 달력과 통계에 반영합니다. 날짜를 바꾼 이력도
                보관합니다.
              </p>
            </>
          )}
        </fieldset>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {conflict && (
          <section className="conflict-panel">
            <strong>초안을 유지했습니다. 최신 기록과 비교해 주세요.</strong>
            <div data-testid="conflict-latest">
              {latest && "content" in latest ? (
                <>
                  <h3>{latest.title}</h3>
                  <p>{latest.content}</p>
                  <small>
                    {kindNameForConflict(latest.kind)} ·{" "}
                    {latest.page ? "p. " + latest.page : "쪽수 없음"}
                  </small>
                </>
              ) : latest && "author" in latest ? (
                <p>
                  {latest.title} · {latest.author} · {latest.publisher} ·{" "}
                  {latest.isbn} · {latest.category || "미분류"} ·{" "}
                  {(latest.bookshelves ?? []).join(", ")}
                </p>
              ) : latest && "status" in latest ? (
                <p>
                  {latest.status === "reading" ? "읽는 중" : "완독"} ·{" "}
                  {latest.currentPage}쪽 ·{" "}
                  {latest.completedOn ?? latest.startedOn ?? "날짜 미입력"}
                </p>
              ) : (
                <p>최신 기록을 불러오지 못했습니다.</p>
              )}
            </div>
            <button
              type="button"
              className="secondary"
              disabled={
                !latest ||
                latest.version <= (baseVersion ?? originalVersion ?? 0) ||
                ("status" in latest &&
                  (editor.kind === "progress" || editor.kind === "complete") &&
                  latest.status !== "reading")
              }
              onClick={() => {
                if (latest) {
                  setBaseVersion(latest.version);
                  setConflict(false);
                  setError("");
                }
              }}
            >
              최신 내용을 확인했습니다. 내 초안을 유지합니다.
            </button>
            <p className="form-hint">
              위 내용을 확인하고 필요하면 입력 내용을 합친 뒤 저장해 주세요.
              저장 전에는 다른 기기의 기록을 덮어쓰지 않습니다.
            </p>
          </section>
        )}
        <footer className="form-footer">
          {editor.kind === "note" && editor.note && !preview && (
            <button
              type="button"
              className="secondary"
              disabled={busy || conflict}
              onClick={() => setConfirmDelete(true)}
            >
              삭제
            </button>
          )}
          {onSaveDraft && (
            <button
              type="submit"
              name="saveMode"
              value="draft"
              className="secondary"
              disabled={busy}
            >
              기기에 임시 저장
            </button>
          )}
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={onClose}
          >
            취소
          </button>
          <button className="primary" disabled={busy || conflict}>
            {busy ? "저장 중…" : preview ? "저장 안내 확인" : "저장하기"}
          </button>
        </footer>
      </form>
      {confirmDelete && (
        <section className="notice" aria-label="기록 삭제 확인">
          <p>
            이 기록을 휴지통으로 옮길까요? ‘기록과 생각’에서 복원할 수 있습니다.
            연구에 담은 인용과 수정 이력은 보존됩니다.
          </p>
          <div className="form-footer">
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirmDelete(false)}
            >
              돌아가기
            </button>
            <button
              type="button"
              disabled={busy || conflict}
              onClick={() => void deleteNote()}
            >
              휴지통으로 이동
            </button>
          </div>
        </section>
      )}
      {editor.kind === "note" && editor.note && !preview && (
        <>
          <CurationDetails
            key={editor.note.id}
            kind="note"
            id={editor.note.id}
          />
          <AssistLauncher library={library} noteId={editor.note.id} />
        </>
      )}
    </Modal>
  );
}
function kindNameForConflict(kind: Note["kind"]) {
  return {
    note: "독서 메모",
    thought: "나의 생각",
    claim: "주장",
    evidence: "근거",
    counterargument: "반론",
    reflection: "생각의 변화",
    highlight: "하이라이트",
    review: "서평",
  }[kind];
}
