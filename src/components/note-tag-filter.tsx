"use client";
import { libraryRequest } from "@/client/replica/request";
import { useRef, useState } from "react";
import { Modal } from "./modal";
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
  onUpdated,
  preview,
  searchable = false,
  onRemoved,
}: {
  tags: string[];
  value: string;
  onChange: (tag: string) => void;
  onUpdated: () => Promise<void>;
  preview: boolean;
  searchable?: boolean;
  onRemoved?: (tag: string) => void;
}) {
  const details = useRef<HTMLDetailsElement>(null);
  const [items, setItems] = useState<Tag[]>([]),
    [pending, setPending] = useState<(Tag & { requestId: string }) | null>(
      null,
    ),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [query, setQuery] = useState("");
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
      if (value === pending.tag) onChange("all");
      setPending(null);
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
  const options = [
    ...new Set([
      ...(searchable && !preview ? [] : tags),
      ...items.map((t) => t.tag),
    ]),
  ]
    .filter(
      (t) =>
        !searchable ||
        t.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
    )
    .sort((a, b) => a.localeCompare(b, "ko"));
  function choose(tag: string) {
    onChange(tag);
    if (details.current) details.current.open = false;
  }
  return (
    <div className="tag-filter">
      <span>태그</span>
      <details
        ref={details}
        onToggle={(e) => {
          if (e.target === e.currentTarget && e.currentTarget.open) {
            setQuery("");
            setPending(null);
            void load();
          }
        }}
      >
        <summary
          role={searchable ? "button" : undefined}
          aria-label={searchable ? "태그 선택" : "기록 태그 필터 · 태그 관리"}
        >
          {value === "all"
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
          <button type="button" onClick={() => choose("all")}>
            모든 태그
          </button>
          <button type="button" onClick={() => choose("untagged")}>
            태그 없는 기록
          </button>
          {options.map((tag) => (
            <div className="tag-option" key={tag}>
              <button type="button" onClick={() => choose(tag)}>
                {tag}
              </button>
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
