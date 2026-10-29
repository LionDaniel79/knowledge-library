"use client";
import { libraryRequest } from "@/client/replica/request";
import { useEffect, useRef, useState } from "react";
import { Modal } from "./modal";
import { containsSearchField } from "@/lib/search-fields";
type Tag = {
  tag: string;
  count: number;
  activeCount: number;
  fingerprint: string;
};
export function NoteTagFilter({
  tags,
  value,
  onChange,
  values,
  onValuesChange,
  onUpdated,
  preview,
  searchable = false,
  selectAll = false,
  onRemoved,
}: {
  tags: string[];
  value: string;
  onChange: (tag: string) => void;
  values?: string[];
  onValuesChange?: (tags: string[]) => void;
  onUpdated: () => Promise<void>;
  preview: boolean;
  searchable?: boolean;
  selectAll?: boolean;
  onRemoved?: (tag: string) => void;
}) {
  const details = useRef<HTMLDetailsElement>(null);
  const selected = values ?? (value === "all" ? [] : [value]);
  const [items, setItems] = useState<Tag[]>([]),
    [removed, setRemoved] = useState<string[]>([]),
    [pending, setPending] = useState<(Tag & { requestId: string }) | null>(
      null,
    ),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [query, setQuery] = useState("");
  useEffect(() => {
    setRemoved((old) =>
      old.some(
        (tag) => !tags.includes(tag) && !items.some((item) => item.tag === tag),
      )
        ? old.filter(
            (tag) =>
              tags.includes(tag) || items.some((item) => item.tag === tag),
          )
        : old,
    );
  }, [tags, items]);
  async function load() {
    if (preview) return;
    setError("");
    try {
      const r = await libraryRequest("/api/note-tags", { cache: "no-store" }),
        body = await r.json();
      if (!r.ok) throw Error(body.error);
      setItems(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : "태그 조회 실패");
    }
  }
  async function remove() {
    if (!pending || busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await libraryRequest("/api/note-tags", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tag: pending.tag,
            fingerprint: pending.fingerprint,
            requestId: pending.requestId,
          }),
        }),
        body = await r.json();
      if (!r.ok) throw Error(body.error);
      if (onValuesChange)
        onValuesChange(selected.filter((tag) => tag !== pending.tag));
      else if (value === pending.tag) onChange("all");
      setPending(null);
      setRemoved((old) => [...old, pending.tag]);
      setItems((items) => items.filter((t) => t.tag !== pending.tag));
      onRemoved?.(pending.tag);
      void onUpdated().catch((e) => setError(e.message));
      void load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "태그 삭제 실패");
    } finally {
      setBusy(false);
    }
  }
  const knownTags = [
    ...new Set([
      ...(selectAll || !searchable || preview ? tags : []),
      ...items.map((t) => t.tag),
      ...(selectAll ? selected.filter((tag) => tag !== "untagged") : []),
    ]),
  ]
    .filter((tag) => !removed.includes(tag))
    .sort((a, b) => a.localeCompare(b, "ko"));
  const options = knownTags.filter(
    (tag) => !searchable || containsSearchField(tag, query),
  );
  const allValues = ["untagged", ...knownTags];
  const allSelected = allValues.every((tag) => selected.includes(tag));
  function choose(tag: string) {
    if (onValuesChange) {
      onValuesChange(
        tag === "all"
          ? []
          : selected.includes(tag)
            ? selected.filter((value) => value !== tag)
            : [...selected, tag],
      );
      return;
    }
    onChange(tag);
    if (details.current) details.current.open = false;
  }
  function choice(tag: string, label: string) {
    return onValuesChange ? (
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 0",
        }}
      >
        <input
          type="checkbox"
          aria-label={label}
          checked={tag === "all" ? !selected.length : selected.includes(tag)}
          onChange={() => choose(tag)}
          style={{ width: 18, height: 18, margin: 0 }}
        />
        <span>{label}</span>
      </label>
    ) : (
      <button type="button" onClick={() => choose(tag)}>
        {label}
      </button>
    );
  }
  return (
    <div className="tag-filter">
      <span>태그</span>
      <details
        ref={details}
        onToggle={(e) => {
          if (e.target === e.currentTarget && e.currentTarget.open) {
            void load();
          }
        }}
      >
        <summary
          onClick={() => {
            if (!details.current?.open) {
              setQuery("");
              setPending(null);
            }
          }}
          role={searchable ? "button" : undefined}
          aria-label={searchable ? "태그 선택" : "기록 태그 필터 · 태그 관리"}
        >
          {onValuesChange
            ? selected.length === 1
              ? selected[0] === "untagged"
                ? "태그 없는 기록"
                : selected[0]
              : selected.length
                ? `${selected.length}개 선택`
                : "모든 태그"
            : value === "all"
              ? "모든 태그"
              : value === "untagged"
                ? "태그 없는 기록"
                : value}
          <span>관리 ▾</span>
        </summary>
        <div className="tag-dropdown">
          {searchable && (
            <input
              type="search"
              aria-label="태그 검색"
              placeholder="태그 검색"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.preventDefault();
                if (e.key === "Escape" && details.current)
                  details.current.open = false;
              }}
            />
          )}
          {selectAll && onValuesChange ? (
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 0",
              }}
            >
              <input
                type="checkbox"
                aria-label="전체 선택"
                checked={allSelected}
                ref={(element) => {
                  if (element)
                    element.indeterminate = selected.length > 0 && !allSelected;
                }}
                onChange={(event) =>
                  onValuesChange(
                    event.target.checked
                      ? [...new Set([...selected, ...allValues])]
                      : [],
                  )
                }
                style={{ width: 18, height: 18, margin: 0 }}
              />
              <span>전체 선택</span>
            </label>
          ) : (
            choice("all", "모든 태그")
          )}
          {choice("untagged", "태그 없는 기록")}
          {options.map((tag) => (
            <div className="tag-option" key={tag}>
              {choice(tag, tag)}
              <button
                type="button"
                className="tag-remove"
                aria-label={`태그 삭제 ${tag}`}
                disabled={preview || busy || !items.some((t) => t.tag === tag)}
                onClick={() => {
                  const item = items.find((t) => t.tag === tag);
                  setPending(
                    item ? { ...item, requestId: crypto.randomUUID() } : null,
                  );
                  if (item && details.current) details.current.open = false;
                }}
              >
                ⊖
              </button>
            </div>
          ))}
          {onValuesChange && (
            <button
              type="button"
              onClick={() => {
                if (details.current) details.current.open = false;
              }}
            >
              선택 완료
            </button>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </div>
      </details>
      {pending && (
        <Modal
          title="태그 삭제 확인"
          canClose={!busy}
          onClose={() => setPending(null)}
        >
          <p>
            ‘{pending.tag}’를 기록 {pending.count}개에서 삭제할까요? 기록 내용은
            그대로 남습니다.
          </p>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <div className="form-footer">
            <button type="button" disabled={busy} onClick={() => void remove()}>
              태그 삭제
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setPending(null)}
            >
              취소
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
