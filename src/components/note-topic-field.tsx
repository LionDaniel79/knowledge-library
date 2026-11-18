"use client";
import {
  forwardRef,
  useImperativeHandle,
  useState,
  useEffect,
  useRef,
} from "react";
import { usePagedResource } from "./use-paged-resource";
import { topicChangesFor, type NoteTopicSnapshot } from "@/lib/note-context";
import type { Membership } from "@/lib/thought-map/types";
import { containsSearchField } from "@/lib/search-fields";
import { useLibraryCommand } from "./use-library-command";
import type { Topic } from "@/lib/thought-map/types";

export type NoteTopicHandle = {
  selected: () => string[];
  recommend: (name: string, isCurrent?: () => boolean) => Promise<void>;
  changes: () => ReturnType<typeof topicChangesFor> | undefined;
};
export const NoteTopicField = forwardRef<
  NoteTopicHandle,
  {
    noteId?: string;
    initial?: string[];
    preview?: boolean;
    onCreatingChange?: (busy: boolean) => void;
    onSelectionChange?: (ids: string[]) => void;
  }
>(function NoteTopicField(
  {
    noteId,
    initial = [],
    preview = false,
    onCreatingChange,
    onSelectionChange,
  },
  ref,
) {
  const resource = usePagedResource<NoteTopicSnapshot>(
    "/api/note-topics" + (noteId ? `?noteId=${noteId}` : ""),
    true,
    undefined,
    { keepPreviousData: true },
  );
  const [query, setQuery] = useState("");
  const [added, setAdded] = useState<Topic[]>([]);
  const command = useLibraryCommand("/api/thought-map", resource.reload);
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
  const selectedRef = useRef(ids);
  selectedRef.current = ids;
  useEffect(() => onSelectionChange?.(ids), [ids.join("|"), onSelectionChange]);
  useImperativeHandle(ref, () => ({
    selected: () => selectedRef.current,
    recommend: async (name, isCurrent) => {
      if (selectedRef.current.length) return;
      const value = name.trim();
      if (!value || value.length > 80)
        throw Error("주제 이름을 확인해 주세요.");
      const existing = topics.find(
        (t) => t.name.trim().toLocaleLowerCase() === value.toLocaleLowerCase(),
      );
      if (existing) {
        setSelection({ ids: [existing.id], base });
        return;
      }
      if (!resource.data || preview || command.busy)
        throw Error("주제를 불러온 뒤 다시 적용해 주세요.");
      await createTopic(value, true, isCurrent);
    },
    changes: () =>
      resource.data || selection || (!noteId && initial.length)
        ? topicChangesFor(ids, selection?.base ?? base)
        : undefined,
  }));
  const topics = [
    ...(resource.data?.topics ?? []),
    ...added.filter(
      (t) => !resource.data?.topics.some((current) => current.id === t.id),
    ),
  ];
  const name = query.trim(),
    canCreate =
      !preview &&
      !!resource.data &&
      !command.busy &&
      !!name &&
      name.length <= 80 &&
      !topics.some(
        (t) => t.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase(),
      );
  async function create() {
    if (canCreate) await createTopic(name, false);
  }
  async function createTopic(
    name: string,
    onlyIfEmpty: boolean,
    isCurrent?: () => boolean,
  ) {
    const payload = {
      name,
      parentId: null,
      aliases: [],
      description: "",
      kdcCodes: [],
    };
    onCreatingChange?.(true);
    try {
      const result = await command.send("upsertTopic", payload);
      if (!result) {
        if (onlyIfEmpty)
          throw Error("주제를 생성하지 못했습니다. 다시 적용해 주세요.");
        return;
      }
      setAdded((old) => [
        ...old,
        {
          ...payload,
          id: result.id,
          version: result.version ?? 1,
          confirmed: true,
        },
      ]);
      if (isCurrent && !isCurrent())
        throw Error(
          "내용이나 기록 종류가 변경되었습니다. 다시 추천받아 주세요.",
        );
      setSelection((old) =>
        onlyIfEmpty && selectedRef.current.length
          ? old
          : {
              ids: [...new Set([...(old?.ids ?? ids), result.id])],
              base: old?.base ?? base,
            },
      );
    } finally {
      onCreatingChange?.(false);
    }
  }
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
          <div className="note-choice-search">
            <input
              aria-label="주제 찾기"
              placeholder="주제 찾기"
              value={query}
              maxLength={80}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.preventDefault();
              }}
            />
            <button
              type="button"
              aria-label="주제 생성"
              disabled={!canCreate}
              onClick={() => void create()}
            >
              생성
            </button>
          </div>
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
                : "검색하거나 새 주제를 생성해 주세요."}
            </small>
          )}
        </div>
        {command.error && <small role="alert">{command.error}</small>}
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
