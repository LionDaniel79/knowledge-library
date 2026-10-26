"use client";
import { forwardRef, useImperativeHandle, useState } from "react";
import { usePagedResource } from "./use-paged-resource";
import { topicChangesFor, type NoteTopicSnapshot } from "@/lib/note-context";
import type { Membership } from "@/lib/thought-map/types";
import { containsSearchField } from "@/lib/search-fields";

export type NoteTopicHandle = {
  changes: () => ReturnType<typeof topicChangesFor> | undefined;
};
export const NoteTopicField = forwardRef<
  NoteTopicHandle,
  { noteId?: string; initial?: string[] }
>(function NoteTopicField({ noteId, initial = [] }, ref) {
  const resource = usePagedResource<NoteTopicSnapshot>(
    "/api/note-topics" + (noteId ? `?noteId=${noteId}` : ""),
  );
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<{
    ids: string[];
    base: Membership[];
  } | null>(null);
  const base = resource.data?.memberships ?? [];
  const ids =
    selection?.ids ??
    (noteId
      ? base.filter((m) => m.status === "accepted").map((m) => m.topicId)
      : initial);
  useImperativeHandle(ref, () => ({
    changes: () =>
      resource.data || selection || (!noteId && initial.length)
        ? topicChangesFor(ids, selection?.base ?? base)
        : undefined,
  }));
  const topics = resource.data?.topics ?? [];
  return (
    <div className="note-topic-field">
      <span>주제</span>
      <details>
        <summary>
          {ids.length
            ? topics
                .filter((t) => ids.includes(t.id))
                .map((t) => t.name)
                .join(", ") || `${ids.length}개 선택`
            : "주제 선택 · 미분류"}
        </summary>
        <div className="note-topic-options">
          <input
            aria-label="주제 찾기"
            placeholder="주제 찾기"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.preventDefault();
            }}
          />
          {topics
            .filter((t) => containsSearchField(t.name, query))
            .map((t) => (
              <label key={t.id}>
                <input
                  type="checkbox"
                  checked={ids.includes(t.id)}
                  onChange={(e) =>
                    setSelection({
                      ids: e.target.checked
                        ? [...ids, t.id]
                        : ids.filter((id) => id !== t.id),
                      base: selection?.base ?? base,
                    })
                  }
                />
                {t.name}
              </label>
            ))}
          {!topics.length && (
            <small>
              {resource.loading
                ? "주제 불러오는 중…"
                : "주제별 자료에서 주제를 추가할 수 있습니다."}
            </small>
          )}
        </div>
      </details>
      {resource.error && (
        <small role="alert">
          {resource.error}{" "}
          <button type="button" onClick={resource.reload}>
            다시 조회
          </button>
        </small>
      )}
    </div>
  );
});
