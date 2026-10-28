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
}: {
  chapter: WritingChapter;
  dx?: number;
  dy?: number;
  onDrag: (event: PointerEvent) => void;
  onChange: (chapter: WritingChapter) => void;
  onRemove: () => void;
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
        <input
          type="number"
          aria-label="목차 번호"
          min={1}
          max={100000}
          value={c.order}
          onChange={(e) =>
            onChange({
              ...c,
              order: Math.max(1, Math.min(100000, Number(e.target.value) || 1)),
            })
          }
        />
        <input
          aria-label="목차 제목"
          maxLength={300}
          value={c.title}
          onChange={(e) => onChange({ ...c, title: e.target.value })}
        />
        <button
          type="button"
          title="상자만 삭제하고 메모는 유지"
          onClick={onRemove}
        >
          상자 삭제
        </button>
      </div>
      <div className="writing-chapter-content">
        <textarea
          aria-label="목차 내용"
          placeholder="이 목차에서 풀어 쓸 생각"
          maxLength={20000}
          value={c.text}
          onChange={(e) => onChange({ ...c, text: e.target.value })}
        />
        <details className="writing-material-orders">
          <summary>자료 순서 · {c.items.length}개</summary>
          {c.items
            .slice()
            .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
            .map((item) => (
              <div key={item.id}>
                <input
                  type="number"
                  min={1}
                  max={100000}
                  aria-label={`${item.label} 순서`}
                  value={item.order}
                  onChange={(e) =>
                    onChange({
                      ...c,
                      items: c.items.map((i) =>
                        i.id === item.id
                          ? {
                              ...i,
                              order: Math.max(
                                1,
                                Math.min(100000, Number(e.target.value) || 1),
                              ),
                            }
                          : i,
                      ),
                    })
                  }
                />
                <span>{item.label}</span>
                <button
                  type="button"
                  aria-label={`${item.label} 목차에서 빼기`}
                  onClick={() =>
                    onChange({
                      ...c,
                      items: c.items.filter((i) => i.id !== item.id),
                    })
                  }
                >
                  빼기
                </button>
              </div>
            ))}
        </details>
      </div>
    </section>
  );
}
