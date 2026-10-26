"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { containsSearchField } from "@/lib/search-fields";
export interface FacetOption {
  value: string;
  label: string;
}
export interface FacetManagement {
  busy: boolean;
  canCreate: (query: string) => boolean;
  onCreate: (query: string) => Promise<void>;
  canRemove: (value: string) => boolean;
  onRemove: (value: string) => void;
  error?: string;
}
export function FacetPicker({
  label,
  options,
  values,
  onChange,
  multiple = true,
  onSearch,
  compact = false,
  management,
}: {
  label: string;
  options: FacetOption[];
  values: string[];
  onChange: (values: string[]) => void;
  multiple?: boolean;
  onSearch?: (query: string) => void;
  compact?: boolean;
  management?: FacetManagement;
}) {
  const [open, setOpen] = useState(false),
    [q, setQ] = useState("");
  const root = useRef<HTMLDivElement>(null),
    touchOpen = useRef(false),
    popup = useRef<HTMLDivElement>(null),
    input = useRef<HTMLInputElement>(null),
    [position, setPosition] = useState({ left: 0, top: 0, width: 280 });
  useLayoutEffect(() => {
    if (!open) return;
    const r = root.current!.getBoundingClientRect(),
      viewportWidth = document.documentElement.clientWidth,
      width = Math.min(300, viewportWidth - 24);
    setPosition({
      left:
        window.scrollX +
        Math.max(8, Math.min(r.left, viewportWidth - width - 8)),
      top: window.scrollY + r.bottom + 6,
      width,
    });
    if (
      !touchOpen.current &&
      window.matchMedia("(hover: hover) and (pointer: fine)").matches
    )
      input.current?.focus({ preventScroll: true });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (
        !root.current?.contains(e.target as Node) &&
        !popup.current?.contains(e.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  const matches = options.filter((o) => containsSearchField(o.label, q));
  const summary =
    values.length === 1
      ? (options.find((o) => o.value === values[0])?.label ?? "선택 1개")
      : values.length
        ? `${values.length}개 선택`
        : "전체";
  return (
    <div
      className="wb-facet"
      ref={root}
      onKeyDown={(e) => {
        if (e.key === "Escape") setOpen(false);
      }}
    >
      <button
        type="button"
        className="wb-facet-toggle"
        aria-label={`${label} 선택`}
        aria-expanded={open}
        aria-haspopup="listbox"
        onPointerDown={(e) => {
          touchOpen.current = e.pointerType !== "mouse";
        }}
        onClick={() => setOpen(!open)}
      >
        {!compact && <small>{label}</small>}
        <span>{summary}</span>
        <span aria-hidden="true">⌄</span>
      </button>
      {open &&
        createPortal(
          <div
            className="wb-facet-popup"
            ref={popup}
            style={position}
            onKeyDown={(e) => {
              if (e.key === "Escape") setOpen(false);
            }}
          >
            <div className="wb-facet-search">
              <input
                ref={input}
                aria-label={`${label} 검색`}
                placeholder={`${label} 검색`}
                value={q}
                maxLength={management ? 80 : undefined}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.preventDefault();
                }}
                onChange={(e) => {
                  setQ(e.target.value);
                  onSearch?.(e.target.value);
                }}
              />
              {management && (
                <button
                  type="button"
                  aria-label={`${label} 생성`}
                  disabled={management.busy || !management.canCreate(q)}
                  onClick={() => void management.onCreate(q)}
                >
                  생성
                </button>
              )}
            </div>
            {management?.error && (
              <p role="alert" className="error">
                {management.error}
              </p>
            )}
            <div
              role="listbox"
              aria-label={`${label} 목록`}
              aria-multiselectable={multiple}
            >
              <button
                type="button"
                role="option"
                aria-selected={!values.length}
                onClick={() => {
                  onChange([]);
                  if (!multiple) setOpen(false);
                }}
              >
                전체 {!values.length && "✓"}
              </button>
              {matches.slice(0, 100).map((o) => {
                const option = (
                  <button
                    type="button"
                    role="option"
                    key={o.value}
                    aria-selected={values.includes(o.value)}
                    onClick={() => {
                      if (!multiple) {
                        onChange([o.value]);
                        setOpen(false);
                        return;
                      }
                      onChange(
                        values.includes(o.value)
                          ? values.filter((v) => v !== o.value)
                          : [...values, o.value],
                      );
                    }}
                  >
                    <span>{o.label}</span>
                    {multiple ? (
                      <span className="facet-check" aria-hidden="true">
                        {values.includes(o.value) ? "☑" : "☐"}
                      </span>
                    ) : (
                      values.includes(o.value) && (
                        <span aria-hidden="true">✓</span>
                      )
                    )}
                  </button>
                );
                return management ? (
                  <div className="wb-facet-option-row" key={o.value}>
                    {option}
                    {management.canRemove(o.value) && (
                      <button
                        type="button"
                        className="facet-remove"
                        aria-label={`${label} 삭제 ${o.label}`}
                        disabled={management.busy}
                        onClick={() => {
                          setOpen(false);
                          management.onRemove(o.value);
                        }}
                      >
                        ⊖
                      </button>
                    )}
                  </div>
                ) : (
                  option
                );
              })}
              {!matches.length && <p>검색 결과 없음</p>}
              {matches.length > 100 && (
                <small>검색어를 입력해 범위를 좁혀 주세요.</small>
              )}
            </div>
            {multiple && (
              <button
                type="button"
                className="facet-done"
                aria-label={`${label} 선택 완료`}
                onClick={() => setOpen(false)}
              >
                선택 완료
              </button>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
