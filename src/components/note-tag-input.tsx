"use client";
import { useEffect, useRef, useState } from "react";
import { libraryRequest } from "@/client/replica/request";
import { containsSearchField } from "@/lib/search-fields";

export function NoteTagInput({
  value: selected = [],
  onChange,
  options = [],
  preview = false,
}: {
  value?: string[];
  onChange: (tags: string[]) => void;
  options?: string[];
  preview?: boolean;
}) {
  const details = useRef<HTMLDetailsElement>(null),
    trigger = useRef<HTMLElement>(null);
  const [draft, setDraft] = useState(selected),
    [query, setQuery] = useState("");
  const [known, setKnown] = useState<string[]>([]),
    [error, setError] = useState("");
  useEffect(() => {
    const dialog = details.current?.closest("dialog");
    if (!dialog) return;
    const cancel = (event: Event) => {
      if (!details.current?.open) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    };
    // Native dialog cancellation follows a different event path in Safari.
    dialog.addEventListener("cancel", cancel, true);
    return () => dialog.removeEventListener("cancel", cancel, true);
  }, []);
  const choices = [
    ...new Set([...options, ...known, ...selected, ...draft]),
  ].sort((a, b) => a.localeCompare(b, "ko"));
  async function load() {
    if (preview) return;
    try {
      const r = await libraryRequest("/api/note-tags", { cache: "no-store" }),
        data = await r.json();
      if (!r.ok) throw Error(data.error ?? "태그를 불러오지 못했습니다.");
      setKnown((old) => [
        ...new Set([...old, ...data.map((t: { tag: string }) => t.tag)]),
      ]);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const name = query.trim(),
    canAdd =
      !!name &&
      name.length <= 40 &&
      !choices.includes(name) &&
      draft.length < 20;
  function close() {
    if (details.current) details.current.open = false;
    trigger.current?.focus({ preventScroll: true });
  }
  return (
    <div className="note-tag-field">
      <span>태그</span>
      <input type="hidden" name="tags" value={selected.join(", ")} />
      <details
        ref={details}
        onToggle={(e) => {
          if (e.target === e.currentTarget && e.currentTarget.open) void load();
        }}
      >
        <summary
          ref={trigger}
          role="button"
          aria-label="기록 태그 선택"
          onClick={() => {
            if (!details.current?.open) {
              setDraft(selected);
              setQuery("");
              setError("");
            }
          }}
        >
          {selected.length ? selected.join(", ") : "태그 선택"}
          <span aria-hidden="true">⌄</span>
        </summary>
        <div className="note-tag-options">
          <div className="note-choice-search">
            <input
              type="search"
              aria-label="기록 태그 검색"
              placeholder="태그 검색·추가"
              maxLength={40}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.preventDefault();
              }}
            />
            <button
              type="button"
              aria-label="태그 추가"
              disabled={!canAdd}
              onClick={() => {
                if (canAdd) {
                  setKnown((old) => [...old, name]);
                  setDraft((old) => [...old, name]);
                  setQuery("");
                }
              }}
            >
              추가
            </button>
          </div>
          <div
            className="note-choice-list"
            role="group"
            aria-label="기록 태그 목록"
          >
            {choices
              .filter((t) => containsSearchField(t, query))
              .map((tag) => (
                <label key={tag}>
                  <input
                    type="checkbox"
                    checked={draft.includes(tag)}
                    disabled={!draft.includes(tag) && draft.length >= 20}
                    onChange={(e) =>
                      setDraft((old) =>
                        e.target.checked
                          ? [...old, tag]
                          : old.filter((t) => t !== tag),
                      )
                    }
                  />
                  {tag}
                </label>
              ))}
            {!choices.some((t) => containsSearchField(t, query)) && (
              <small>선택할 태그가 없습니다.</small>
            )}
          </div>
          {error && <small role="alert">{error}</small>}
          <div className="note-choice-actions">
            <span>{draft.length}개 선택</span>
            <button type="button" aria-label="태그 취소" onClick={close}>
              취소
            </button>
            <button
              type="button"
              className="primary"
              aria-label="태그 적용"
              onClick={() => {
                onChange(draft);
                close();
              }}
            >
              적용
            </button>
          </div>
        </div>
      </details>
    </div>
  );
}
