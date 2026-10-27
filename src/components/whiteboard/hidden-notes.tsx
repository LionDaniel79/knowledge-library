"use client";
import { useState } from "react";
import type { Note } from "@/lib/domain";
export function HiddenWhiteboardNotes({
  notes,
  busy,
  onOpen,
  onShow,
}: {
  notes: Note[];
  busy: boolean;
  onOpen: (id: string) => void;
  onShow: (ids: string[]) => Promise<boolean>;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const ids = selected.filter((id) => notes.some((n) => n.id === id));
  return (
    <details className="wb-hidden-notes">
      <summary>가려진 메모 · {notes.length}개</summary>
      <div className="wb-hidden-tools">
        <label>
          <input
            type="checkbox"
            aria-label="가려진 메모 전체 선택"
            disabled={busy || !notes.length}
            checked={!!notes.length && ids.length === notes.length}
            onChange={(e) =>
              setSelected(e.target.checked ? notes.map((n) => n.id) : [])
            }
          />
          전체 선택
        </label>
        <button
          type="button"
          disabled={busy || !ids.length}
          onClick={async () => {
            const sent = ids;
            if (await onShow(sent))
              setSelected((old) => old.filter((id) => !sent.includes(id)));
          }}
        >
          선택한 메모 보이기
        </button>
      </div>
      {notes.map((n) => {
        const title = n.title || n.content.slice(0, 60) || "메모";
        return (
          <div className="wb-hidden-row" key={n.id}>
            <label className="wb-connection-check">
              <input
                type="checkbox"
                aria-label={`${title} 보이기 선택`}
                disabled={busy}
                checked={selected.includes(n.id)}
                onChange={(e) =>
                  setSelected((old) =>
                    e.target.checked
                      ? [...old, n.id]
                      : old.filter((id) => id !== n.id),
                  )
                }
              />
            </label>
            <button
              type="button"
              className="wb-connection-select"
              onClick={() => onOpen(n.id)}
              aria-label={`${title} 세부정보`}
            >
              {title}
            </button>
          </div>
        );
      })}
      {!notes.length && <p>가려진 메모가 없습니다.</p>}
    </details>
  );
}
