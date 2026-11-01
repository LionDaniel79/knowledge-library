"use client";
import type { PointerEvent } from "react";
import type { WritingChapter } from "@/lib/writing-board";
export function ChapterBox({
  chapter: c,
  dx = 0,
  dy = 0,
  onDrag,
  onChange,
  onRemove,
  numbered = false,
  onAddSelected,
  canAddSelected = false,
}: {
  chapter: WritingChapter;
  dx?: number;
  dy?: number;
  onDrag: (event: PointerEvent) => void;
  onChange: (chapter: WritingChapter) => void;
  onRemove: () => void;
  numbered?: boolean;
  onAddSelected?: () => void;
  canAddSelected?: boolean;
}) {
  return (
    <section
      className="writing-chapter"
      style={{
        left: c.x + dx,
        top: c.y + dy,
        width: c.width,
        height: c.height,
      }}
      data-chapter-id={c.id}
    >
      <div className="writing-chapter-head" onPointerDown={onDrag}>
        {numbered && (
          <input
            type="number"
            aria-label="목차 번호"
            min={1}
            max={100000}
            value={c.order}
            onChange={(e) =>
              onChange({
                ...c,
                order: Math.max(
                  1,
                  Math.min(100000, Number(e.target.value) || 1),
                ),
              })
            }
          />
        )}
        <input
          aria-label={numbered ? "목차 제목" : "상자 제목"}
          maxLength={300}
          value={c.title}
          onChange={(e) => onChange({ ...c, title: e.target.value })}
        />
        <button
          type="button"
          title={
            numbered
              ? "이 글감에서 상자 삭제"
              : "생각묶음 삭제, 메모 원문은 유지"
          }
          onClick={() => {
            if (
              window.confirm(
                numbered
                  ? "이 글감에서 상자를 삭제할까요? 생각묶음과 메모 원문은 유지됩니다."
                  : "이 생각묶음을 삭제할까요? 모든 생각묶음 목록에서 삭제되며 메모 원문은 유지됩니다.",
              )
            )
              onRemove();
          }}
        >
          상자 삭제
        </button>
        {onAddSelected && (
          <button
            type="button"
            disabled={!canAddSelected}
            onClick={onAddSelected}
          >
            선택 메모 담기
          </button>
        )}
      </div>
      <div className="writing-chapter-content">
        <textarea
          aria-label={numbered ? "목차 내용" : "상자 내용"}
          placeholder="이 목차에서 풀어 쓸 생각"
          maxLength={20000}
          value={c.text}
          onChange={(e) => onChange({ ...c, text: e.target.value })}
        />
      </div>
    </section>
  );
}
