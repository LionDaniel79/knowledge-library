"use client";
import { useState } from "react";
import { defaultShelves } from "@/lib/catalog";
import type { Book, Command, Library } from "@/lib/domain";
import { formEditBase } from "@/lib/replica/command-envelope";
export function ShelfPicker({
  library,
  selected,
  onChange,
  onSave,
  preview,
  disabled = false,
}: {
  disabled?: boolean;
  library: Library;
  selected: string[];
  onChange: (v: string[]) => void;
  onSave: (c: Command) => Promise<void>;
  preview: boolean;
}) {
  const [name, setName] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <fieldset className="shelf-picker" disabled={busy || disabled}>
      <legend>책장 · 여러 개 선택 가능</legend>
      <div className="shelf-options">
        {[
          ...new Set([
            ...defaultShelves,
            ...(library.shelves ?? []),
            ...selected,
          ]),
        ].map((s) => (
          <label className="check-label" key={s}>
            <input
              type="checkbox"
              name="bookshelves"
              value={s}
              checked={selected.includes(s)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? [...selected, s]
                    : selected.filter((v) => v !== s),
                )
              }
            />
            {s}
          </label>
        ))}
      </div>
      <div className="new-shelf">
        <input
          aria-label="새 책장 이름"
          placeholder="새 책장 이름"
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.preventDefault();
          }}
        />
        <button
          type="button"
          className="secondary"
          disabled={busy || !name.trim()}
          onClick={async () => {
            if (preview) {
              setError("내 서재에 로그인하면 책장을 추가할 수 있습니다.");
              return;
            }
            setBusy(true);
            setError("");
            try {
              await onSave({
                type: "createShelf",
                requestId: crypto.randomUUID(),
                payload: { name: name.trim() },
              });
              onChange([...new Set([...selected, name.trim()])]);
              setName("");
            } catch (e) {
              setError(
                e instanceof Error ? e.message : "책장을 추가하지 못했습니다.",
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "추가 중…" : "책장 추가"}
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
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
  const [selected, setSelected] = useState(book.bookshelves ?? []),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [baseVersion, setBaseVersion] = useState(book.version);
  const [editBase, setEditBase] = useState(() => formEditBase(book));
  const [conflict, setConflict] = useState(false);
  const changed =
    JSON.stringify(selected) !== JSON.stringify(book.bookshelves ?? []);
  return (
    <section className="detail-shelves">
      <ShelfPicker
        library={library}
        selected={selected}
        onChange={setSelected}
        onSave={onSave}
        preview={preview}
        disabled={busy}
      />
      {changed && (
        <button
          className="primary"
          disabled={busy || conflict}
          onClick={async () => {
            if (preview) {
              setError("내 서재에 로그인하면 저장할 수 있습니다.");
              return;
            }
            setBusy(true);
            try {
              await onSave({
                type: "editBook",
                editBase,
                requestId: crypto.randomUUID(),
                payload: {
                  ...book,
                  bookshelves: selected,
                  expectedVersion: baseVersion,
                },
              });
              setBaseVersion(baseVersion + 1);
              setEditBase(formEditBase({ ...book, bookshelves: selected }));
              setError("");
            } catch (e) {
              setError(e instanceof Error ? e.message : "저장 실패");
              if ((e as { status?: number }).status === 409) setConflict(true);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "저장 중…" : "책장 선택 저장"}
        </button>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {conflict && (
        <div className="notice">
          <p>
            내 선택은 유지했습니다. 최신 책장:{" "}
            {(book.bookshelves ?? []).join(", ") || "없음"}
          </p>
          <button
            className="secondary"
            disabled={book.version <= baseVersion}
            onClick={() => {
              setBaseVersion(book.version);
              setConflict(false);
              setError("");
            }}
          >
            최신 책장을 확인했습니다. 내 선택 유지
          </button>
        </div>
      )}
    </section>
  );
}
