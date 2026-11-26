"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Pencil } from "lucide-react";
import { libraryRequest } from "@/client/replica/request";
import {
  bookInformationFields,
  bookInformationText,
  displayedBookInformation,
  type BookInformationField,
} from "@/lib/book-detail-information";
import type { Book } from "@/lib/domain";
import type { CurrentBookInformation } from "@/lib/unified-book-information";
import { pdfOutlineSchema } from "@/lib/pdf-outline";
import { printedTocSchema } from "@/lib/printed-toc";
import { PdfOutlineView } from "./pdf-outline";
import { PrintedTocView } from "./printed-toc";

type Draft = Record<BookInformationField, string>;
export type SavedBookInformation = {
  version: number;
  enrichment: Book["enrichment"];
};
type CurationRead = {
  items?: unknown[];
  currentInformation?: CurrentBookInformation;
  version?: string;
};

export function UnifiedBookInformation({
  book,
  preview = false,
  onChanged,
}: {
  book: Book;
  preview?: boolean;
  onChanged: (change: SavedBookInformation) => void;
}) {
  const [curation, setCuration] = useState<CurationRead | null>(null);
  const [saved, setSaved] = useState<SavedBookInformation | null>(null);
  const [edit, setEdit] = useState<{
    version: number;
    initial: Draft;
    draft: Draft;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(!preview);
  const submitting = useRef(false);
  const current = saved && saved.version >= book.version ? saved : book;
  const currentVersion = current.version;
  const enrichment = current.enrichment;
  useEffect(() => {
    if (preview) return;
    const controller = new AbortController();
    setLoading(true);
    void libraryRequest(
      "/api/curation?kind=book&id=" + encodeURIComponent(book.id),
      { cache: "no-store", signal: controller.signal },
      { preferServer: reload > 0 },
    )
      .then(async (response) => {
        if (response.ok && !controller.signal.aborted) {
          const result = await response.json();
          if (!controller.signal.aborted) setCuration(result);
        }
      })
      .catch(() => {
        // Information already on the book remains available offline.
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [book.id, currentVersion, preview, reload]);
  const values = displayedBookInformation(
    enrichment,
    curation?.items,
    Number(curation?.version) >= currentVersion
      ? curation?.currentInformation
      : undefined,
  );
  const description = bookInformationText(values.description);
  const toc = values.toc;
  const outline = pdfOutlineSchema.safeParse(toc);
  const printed = printedTocSchema.safeParse(toc);
  const tocText = bookInformationText(toc);
  const attribution = enrichment?.autoBibliography as
    { provider?: string; afterValues?: Record<string, unknown> } | undefined;
  const supplied = enrichment?.catalogSelection as
    { provider?: string; description?: string } | undefined;
  const editedFields =
    (enrichment?.bookInformationEdits as string[] | undefined) ?? [];
  const yes24 =
    (attribution?.provider === "예스24" &&
      (["description", "toc"] as const).some(
        (field) =>
          values[field] != null &&
          !editedFields.includes(field) &&
          bookInformationText(values[field]) ===
            bookInformationText(attribution.afterValues?.[field]),
      )) ||
    (supplied?.provider === "yes24" &&
      !!description &&
      description === supplied.description &&
      !editedFields.includes("description"));

  function startEdit() {
    const initial = Object.fromEntries(
      bookInformationFields.map(([field]) => [
        field,
        bookInformationText(values[field]),
      ]),
    ) as Draft;
    setEdit({ version: currentVersion, initial, draft: initial });
    setMessage("");
    setError("");
  }

  const changes = edit
    ? Object.fromEntries(
        bookInformationFields
          .filter(
            ([field]) =>
              edit.draft[field].trim() !== edit.initial[field].trim(),
          )
          .map(([field]) => [field, edit.draft[field].trim()]),
      )
    : {};
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!edit || submitting.current || !Object.keys(changes).length) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await libraryRequest(
        "/api/curation",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "editBookInformation",
            bookId: book.id,
            expectedVersion: edit.version,
            changes,
          }),
        },
        { preferServer: true },
      );
      const result = await response.json();
      if (!response.ok)
        throw Error(result.error ?? "책 정보를 저장하지 못했습니다.");
      setSaved(result);
      setEdit(null);
      setMessage("책 정보를 저장했습니다.");
      onChanged(result);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "책 정보를 저장하지 못했습니다.",
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <section
      className="book-detail-section unified-book-information"
      aria-label="자동 보완 내역"
    >
      <header className="book-detail-section-heading">
        <h3>자동 보완 내역</h3>
        {!preview && !edit && (
          <button
            className="secondary book-detail-edit"
            type="button"
            aria-label="자동 보완 정보 수정"
            disabled={loading}
            onClick={startEdit}
          >
            <Pencil size={14} aria-hidden="true" />
            수정
          </button>
        )}
      </header>
      {message && (
        <p className="muted" role="status">
          {message}
        </p>
      )}
      {edit ? (
        <form onSubmit={save} className="book-information-form">
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {bookInformationFields.map(([field, label]) => {
            const update = (value: string) =>
              setEdit(
                (old) =>
                  old && {
                    ...old,
                    draft: { ...old.draft, [field]: value },
                  },
              );
            return (
              <label
                key={field}
                className={
                  field === "description" || field === "toc"
                    ? "book-info-wide"
                    : ""
                }
              >
                {label}
                {field === "description" || field === "toc" ? (
                  <textarea
                    rows={field === "description" ? 4 : 5}
                    maxLength={field === "description" ? 8000 : 64000}
                    value={edit.draft[field]}
                    onChange={(event) => update(event.target.value)}
                  />
                ) : (
                  <input
                    inputMode={
                      field === "publicationYear" ? "numeric" : undefined
                    }
                    maxLength={field === "publicationYear" ? 4 : 30}
                    value={edit.draft[field]}
                    onChange={(event) => update(event.target.value)}
                  />
                )}
              </label>
            );
          })}
          <div className="form-footer book-info-wide">
            <button
              className="secondary"
              type="button"
              disabled={busy}
              onClick={() => {
                setEdit(null);
                setError("");
                setReload((value) => value + 1);
              }}
            >
              취소
            </button>
            <button
              className="primary"
              type="submit"
              disabled={busy || !Object.keys(changes).length}
            >
              {busy ? "저장 중…" : "저장"}
            </button>
          </div>
        </form>
      ) : (
        <>
          {values.publicationYear != null || values.referenceIsbn != null ? (
            <dl className="book-information-facts">
              {values.publicationYear != null && (
                <>
                  <dt>발행연도</dt>
                  <dd>{bookInformationText(values.publicationYear)}</dd>
                </>
              )}
              {values.referenceIsbn != null && (
                <>
                  <dt>참고 판본 ISBN</dt>
                  <dd>{bookInformationText(values.referenceIsbn)}</dd>
                </>
              )}
            </dl>
          ) : null}
          {description && (
            <details className="book-information-disclosure">
              <summary>책 소개</summary>
              <p>{description}</p>
            </details>
          )}
          {tocText && (
            <details className="book-information-disclosure">
              <summary>목차</summary>
              {outline.success ? (
                <PdfOutlineView value={outline.data} />
              ) : printed.success ? (
                <PrintedTocView value={printed.data} />
              ) : (
                <p>{tocText}</p>
              )}
            </details>
          )}
          {yes24 && <small className="catalog-credit">예스24</small>}
          {!Object.keys(values).length && (
            <p className="muted">
              {loading
                ? "책 정보를 불러오는 중…"
                : "추가로 저장된 도서정보가 없습니다."}
            </p>
          )}
        </>
      )}
    </section>
  );
}
