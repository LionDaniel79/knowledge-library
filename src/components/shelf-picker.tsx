"use client";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { defaultShelves } from "@/lib/catalog";
import type { Book, Command, Library } from "@/lib/domain";
import { formEditBase } from "@/lib/replica/command-envelope";
import {
  changeShelfSelection,
  sameShelfSelection,
  toggleVisibleShelves,
  unclassifiedShelf,
} from "@/lib/shelf-selection";

export function ShelfPicker({
  library,
  selected,
  onChange,
  onSave,
  onConfirm,
  confirmDisabled = false,
  children,
  preview,
  disabled = false,
}: {
  disabled?: boolean;
  confirmDisabled?: boolean;
  children?: ReactNode;
  library: Library;
  selected: string[];
  onChange: (v: string[]) => void;
  onSave: (c: Command) => Promise<void>;
  onConfirm?: (v: string[]) => Promise<void>;
  preview: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<string[]>([]);
  const [original, setOriginal] = useState<string[]>([]);
  const [added, setAdded] = useState<string[]>([]);
  const [deleted, setDeleted] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLFieldSetElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const normalized = (value: string) => value.trim().toLocaleLowerCase();
  const shelves = [
    ...new Set([
      ...defaultShelves,
      ...(library.shelves ?? []),
      ...selected,
      ...added,
    ]),
  ].filter((shelf) => shelf !== unclassifiedShelf && !deleted.includes(shelf));
  const visible = shelves.filter((shelf) =>
    normalized(shelf).includes(normalized(query)),
  );
  const showUnclassified = normalized(unclassifiedShelf).includes(
    normalized(query),
  );
  const name = query.trim();
  const canCreate =
    !!name &&
    name !== unclassifiedShelf &&
    !shelves.some((shelf) => normalized(shelf) === normalized(name));
  const changed = !sameShelfSelection(draft, original);
  const canComplete = draft.length > 0 || changed;
  const allVisible =
    !!visible.length && visible.every((shelf) => draft.includes(shelf));
  const partlyVisible =
    !allVisible && visible.some((shelf) => draft.includes(shelf));

  function close(restoreFocus = false) {
    setOpen(false);
    setQuery("");
    setError("");
    if (restoreFocus) trigger.current?.focus();
  }

  useEffect(() => {
    if (!open || busy) return;
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !root.current?.contains(event.target)
      ) {
        setOpen(false);
        setQuery("");
        setError("");
      }
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open, busy]);

  async function act() {
    if (busy || (!canCreate && (!canComplete || confirmDisabled))) return;
    if (canCreate && preview) {
      setError("내 서재에 로그인하면 책장을 추가할 수 있습니다.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (canCreate) {
        await onSave({
          type: "createShelf",
          requestId: crypto.randomUUID(),
          payload: { name },
        });
        setAdded((values) => [...new Set([...values, name])]);
        setDeleted((values) => values.filter((shelf) => shelf !== name));
        setDraft((values) => changeShelfSelection(values, name, true));
        setQuery("");
      } else {
        if (changed) {
          await onConfirm?.(draft);
          onChange(draft);
        }
        close(true);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "책장을 저장하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteShelf(shelf: string) {
    if (preview) {
      setError("내 서재에 로그인하면 책장을 삭제할 수 있습니다.");
      return;
    }
    if (
      !window.confirm(
        `‘${shelf}’ 책장을 삭제할까요?\n이 책장은 모든 도서의 책장 목록에서 제거됩니다. 도서, 메모, 독서 기록 등의 데이터는 삭제하지 않습니다.`,
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      await onSave({
        type: "deleteShelf",
        requestId: crypto.randomUUID(),
        payload: { name: shelf },
      });
      setDeleted((values) => [...values, shelf]);
      setAdded((values) => values.filter((value) => value !== shelf));
      setDraft((values) => values.filter((value) => value !== shelf));
      setOriginal((values) => values.filter((value) => value !== shelf));
      onChange(selected.filter((value) => value !== shelf));
    } catch (e) {
      setError(e instanceof Error ? e.message : "책장을 삭제하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <fieldset
      className="shelf-picker shelf-dropdown"
      disabled={disabled}
      ref={root}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          if (!busy) close(true);
        }
      }}
    >
      <legend>책장</legend>
      <button
        type="button"
        className="shelf-dropdown-trigger"
        aria-label="책장 선택"
        aria-expanded={open}
        aria-controls={listId}
        ref={trigger}
        disabled={busy}
        onClick={(event) => {
          if (open) return close();
          const initial = selected.filter(
            (shelf) => shelf !== unclassifiedShelf && !deleted.includes(shelf),
          );
          setOriginal(initial);
          setDraft(initial);
          setQuery("");
          setError("");
          setOpen(true);
          // Keyboard users can type immediately. Touch/pointer opening never summons the keyboard.
          if (event.detail === 0)
            requestAnimationFrame(() => input.current?.focus());
        }}
      >
        <span>
          {selected.filter((shelf) => !deleted.includes(shelf)).join(", ") ||
            unclassifiedShelf}
        </span>
        <span aria-hidden="true">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div className="shelf-dropdown-panel" id={listId}>
          <div className="shelf-dropdown-search">
            <input
              ref={input}
              aria-label="책장 검색 또는 생성"
              placeholder="책장 검색 또는 생성"
              maxLength={80}
              value={query}
              disabled={busy}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void act();
                }
              }}
            />
            <button
              type="button"
              className="primary"
              disabled={
                busy || (!canCreate && (!canComplete || confirmDisabled))
              }
              onClick={() => void act()}
            >
              {busy ? "처리 중…" : canCreate || !canComplete ? "생성" : "완료"}
            </button>
          </div>
          {!!visible.length && (
            <label className="shelf-dropdown-all check-label">
              <input
                type="checkbox"
                checked={allVisible}
                ref={(element) => {
                  if (element) element.indeterminate = partlyVisible;
                }}
                disabled={busy}
                onChange={() =>
                  setDraft((values) => toggleVisibleShelves(values, visible))
                }
              />
              전체선택
            </label>
          )}
          <div
            className="shelf-dropdown-options"
            role="group"
            aria-label="책장 목록"
          >
            {showUnclassified && (
              <label className="check-label shelf-dropdown-row">
                <input
                  type="checkbox"
                  checked={!draft.length}
                  disabled={busy}
                  onChange={() => setDraft([])}
                />
                <span>{unclassifiedShelf}</span>
              </label>
            )}
            {visible.map((shelf) => (
              <div className="shelf-dropdown-row" key={shelf}>
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={draft.includes(shelf)}
                    disabled={busy}
                    onChange={(event) =>
                      setDraft((values) =>
                        changeShelfSelection(
                          values,
                          shelf,
                          event.target.checked,
                        ),
                      )
                    }
                  />
                  <span>{shelf}</span>
                </label>
                {!defaultShelves.includes(shelf) && (
                  <button
                    type="button"
                    className="shelf-dropdown-delete"
                    aria-label={`${shelf} 책장 삭제`}
                    title="책장 삭제"
                    disabled={busy}
                    onClick={() => void deleteShelf(shelf)}
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
            {!visible.length && !showUnclassified && (
              <p className="muted">일치하는 책장이 없습니다.</p>
            )}
          </div>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {children}
        </div>
      )}
    </fieldset>
  );
}

export function BookShelves({
  book,
  library,
  onSave,
  preview,
}: {
  book: Book;
  library: Library;
  onSave: (c: Command) => Promise<void>;
  preview: boolean;
}) {
  const [selected, setSelected] = useState(book.bookshelves ?? []);
  const [baseVersion, setBaseVersion] = useState(book.version);
  const [editBase, setEditBase] = useState(() => formEditBase(book));
  const [conflict, setConflict] = useState(false);
  useEffect(() => {
    setSelected(book.bookshelves ?? []);
  }, [book.bookshelves]);
  return (
    <section className="detail-shelves">
      <ShelfPicker
        library={library}
        selected={selected}
        onChange={setSelected}
        onSave={async (command) => {
          await onSave(command);
          if (command.type === "deleteShelf") {
            const name = (command.payload as { name: string }).name;
            if (selected.includes(name)) {
              setBaseVersion((version) => version + 1);
              setEditBase(
                formEditBase({
                  ...book,
                  bookshelves: selected.filter((shelf) => shelf !== name),
                }),
              );
            }
          }
        }}
        preview={preview}
        confirmDisabled={conflict}
        onConfirm={async (selection) => {
          if (preview) throw Error("내 서재에 로그인하면 저장할 수 있습니다.");
          try {
            await onSave({
              type: "editBook",
              editBase,
              requestId: crypto.randomUUID(),
              payload: {
                ...book,
                bookshelves: selection,
                expectedVersion: baseVersion,
              },
            });
            setBaseVersion(baseVersion + 1);
            setEditBase(formEditBase({ ...book, bookshelves: selection }));
          } catch (error) {
            if ((error as { status?: number }).status === 409)
              setConflict(true);
            throw error;
          }
        }}
      >
        {conflict && (
          <div className="notice">
            <p>
              내 선택은 유지했습니다. 최신 책장:{" "}
              {(book.bookshelves ?? []).join(", ") || "없음"}
            </p>
            <button
              type="button"
              className="secondary"
              disabled={book.version <= baseVersion}
              onClick={() => {
                setBaseVersion(book.version);
                setEditBase(formEditBase(book));
                setConflict(false);
              }}
            >
              최신 책장을 확인했습니다. 내 선택 유지
            </button>
          </div>
        )}
      </ShelfPicker>
    </section>
  );
}
