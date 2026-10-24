"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
export interface FacetOption {
  value: string;
  label: string;
}
export function FacetPicker({
  label,
  options,
  values,
  onChange,
}: {
  label: string;
  options: FacetOption[];
  values: string[];
  onChange: (values: string[]) => void;
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
  const matches = options.filter((o) =>
    o.label.toLocaleLowerCase().includes(q.trim().toLocaleLowerCase()),
  );
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
        <small>{label}</small>
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
            <input
              ref={input}
              aria-label={`${label} 검색`}
              placeholder={`${label} 검색`}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <div
              role="listbox"
              aria-label={`${label} 목록`}
              aria-multiselectable="true"
            >
              <button
                type="button"
                role="option"
                aria-selected={!values.length}
                onClick={() => onChange([])}
              >
                전체 {!values.length && "✓"}
              </button>
              {matches.slice(0, 100).map((o) => (
                <button
                  type="button"
                  role="option"
                  key={o.value}
                  aria-selected={values.includes(o.value)}
                  onClick={() =>
                    onChange(
                      values.includes(o.value)
                        ? values.filter((v) => v !== o.value)
                        : [...values, o.value],
                    )
                  }
                >
                  <span>{o.label}</span>
                  {values.includes(o.value) && (
                    <span aria-hidden="true">✓</span>
                  )}
                </button>
              ))}
              {!matches.length && <p>검색 결과 없음</p>}
              {matches.length > 100 && (
                <small>검색어를 입력해 범위를 좁혀 주세요.</small>
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
