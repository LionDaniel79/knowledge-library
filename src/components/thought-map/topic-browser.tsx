"use client";
import { useState, useMemo } from "react";
import type { NewNoteContext } from "@/lib/note-context";
import { NoteTagFilter } from "../note-tag-filter";
import { NoteBookFilter } from "../note-book-filter";
import { NoteTrash } from "../note-trash";
import { AssistLauncher } from "../assist-panel";
import { noteKindNames } from "@/lib/note-kinds";
import type { Library, Command } from "@/lib/domain";
import { categories, categoryName } from "@/lib/catalog";
import type { ThoughtMapSnapshot } from "@/lib/thought-map/types";
import { buildTopicMaterials, pageTopicMaterials } from "@/lib/topic-materials";
import { useMaterialPage } from "../use-material-page";
import {
  useListPagination,
  PageSizeSelect,
  PageNavigation,
} from "../list-pagination";
import { TopicPicker, type ThoughtSend } from "./topic-picker";
import { TopicManager } from "./topic-manager";
import { useTopicOrder } from "./use-topic-order";
import { useReplicaOptional } from "../replica/provider";
import { TopicFilter } from "../topic-filter";
import { FacetPicker } from "../whiteboard/facet-picker";
type RecordFilters = {
  noteTypes: string[];
  categories: string[];
  bookIds: string[];
  topics: string[];
  tags: string[];
  q: string;
  sort: string;
};
export function TopicBrowser({
  library,
  state,
  send,
  busy,
  error = "",
  onOpen,
  ownerId = "",
  onUpdated = async () => {},
  onSaveNote,
  initialTag = "all",
  onTopicsUpdated = () => {},
}: {
  library: Library;
  state: ThoughtMapSnapshot;
  send: ThoughtSend;
  busy: boolean;
  error?: string;
  onOpen: (kind: string, id: string) => void;
  ownerId?: string;
  onUpdated?: () => Promise<void>;
  onSaveNote?: (c: Command) => Promise<void>;
  onNewNote?: (c: NewNoteContext) => void;
  initialTag?: string;
  onTopicsUpdated?: () => void;
}) {
  const initialFilters = (): RecordFilters => ({
    noteTypes: [],
    categories: [],
    bookIds: [],
    topics: [],
    tags: initialTag === "all" ? [] : [initialTag],
    q: "",
    sort: "newest",
  });
  const [draft, setDraft] = useState(initialFilters),
    [applied, setApplied] = useState(initialFilters);
  const selected = draft.topics.length === 1 ? draft.topics[0] : "all";
  function change<K extends keyof RecordFilters>(
    key: K,
    value: RecordFilters[K],
  ) {
    setDraft((old) => ({ ...old, [key]: value }));
  }
  function removed(key: "topics" | "tags", id: string) {
    setDraft((old) => ({
      ...old,
      [key]: old[key].filter((value) => value !== id),
    }));
    setApplied((old) => ({
      ...old,
      [key]: old[key].filter((value) => value !== id),
    }));
  }
  const replica = useReplicaOptional();
  const { topics: orderedTopics, move: moveTopic } = useTopicOrder(
    state.topics,
    ownerId || replica?.runtime?.owner || "preview",
  );
  const paging = useListPagination("topic-materials", JSON.stringify(applied));
  const query = useMemo(
    () => ({
      categories: JSON.stringify(applied.categories),
      q: applied.q,
      kind: "note",
      noteTypes: JSON.stringify(applied.noteTypes),
      tags: JSON.stringify(applied.tags),
      bookIds: JSON.stringify(applied.bookIds),
      topics: JSON.stringify(applied.topics),
      sort: applied.sort,
      limit: paging.size,
      offset: paging.offset,
    }),
    [applied, paging.size, paging.offset],
  );
  const catalog = useMaterialPage(
    !!library.catalog && paging.ready,
    query,
    state,
  );
  const local = useMemo(
    () =>
      library.catalog
        ? { total: 0, items: [] }
        : pageTopicMaterials(
            buildTopicMaterials({
              books: library.books,
              notes: state.notes ?? library.notes,
              topics: state.topics,
              memberships: state.memberships,
            }),
            query,
          ),
    [
      library.catalog,
      library.books,
      library.notes,
      state.notes,
      state.topics,
      state.memberships,
      query,
    ],
  );
  const total = library.catalog ? catalog.total : local.total;
  const shown = library.catalog ? catalog.items : local.items;
  const membershipMap = useMemo(() => {
    const map = new Map<string, typeof state.memberships>(),
      valid = new Set(state.topics.map((t) => t.id));
    for (const m of state.memberships) {
      if (!valid.has(m.topicId)) continue;
      const key = m.sourceKind + ":" + m.sourceId;
      const list = map.get(key) ?? [];
      list.push(m);
      map.set(key, list);
    }
    return map;
  }, [state.memberships, state.topics]);
  const assigned = (m: { kind: string; id: string }) =>
    (membershipMap.get(m.kind + ":" + m.id) ?? []).filter(
      (a) => a.status !== "rejected",
    );
  return (
    <div className="thought-layout topic-material-layout">
      <div className="thought-materials">
        <form
          className="panel thought-filters topic-material-filters unified-notes-filters"
          onSubmit={(e) => {
            e.preventDefault();
            setApplied(draft);
          }}
        >
          <label className="note-kind-filter">
            종류
            <FacetPicker
              compact
              label="종류"
              values={draft.noteTypes}
              onChange={(values) => change("noteTypes", values)}
              options={[
                { value: "unclassified", label: "미분류 메모" },
                ...Object.entries(noteKindNames).map(([value, label]) => ({
                  value,
                  label,
                })),
              ]}
            />
          </label>
          <label className="note-category-filter">
            도서 분야
            <FacetPicker
              compact
              label="도서 분야"
              values={draft.categories}
              onChange={(values) => change("categories", values)}
              options={[
                { value: "unclassified", label: "미분류" },
                ...categories.map(([value, label]) => ({ value, label })),
              ]}
            />
          </label>
          <NoteBookFilter
            library={library}
            value={draft.bookIds[0] ?? "all"}
            onChange={(id) => change("bookIds", id === "all" ? [] : [id])}
            values={draft.bookIds}
            onValuesChange={(ids) => change("bookIds", ids)}
          />
          <TopicFilter
            topics={orderedTopics}
            value={selected}
            onChange={(id) => change("topics", id === "all" ? [] : [id])}
            values={draft.topics}
            onValuesChange={(ids) => change("topics", ids)}
            onRemoved={(id) => removed("topics", id)}
            onUpdated={async () => {
              onTopicsUpdated();
              await onUpdated();
            }}
          />
          <NoteTagFilter
            searchable
            tags={(state.notes ?? library.notes).flatMap((n) => n.tags ?? [])}
            value={draft.tags[0] ?? "all"}
            onChange={(tag) => change("tags", tag === "all" ? [] : [tag])}
            values={draft.tags}
            onValuesChange={(tags) => change("tags", tags)}
            onRemoved={(tag) => removed("tags", tag)}
            onUpdated={onUpdated}
            preview={false}
          />
          <label className="note-sort-filter">
            정렬
            <select
              value={draft.sort}
              onChange={(e) => change("sort", e.target.value)}
            >
              <option value="newest">최신순</option>
              <option value="oldest">오래된 순</option>
              <option value="category">분야별</option>
              <option value="topic">주제별</option>
              <option value="book">책별</option>
            </select>
          </label>
          <label className="topic-material-search">
            검색
            <input
              type="search"
              value={draft.q}
              onChange={(e) => change("q", e.target.value)}
              placeholder="제목·내용 검색"
            />
          </label>

          <p className="topic-material-count" aria-live="polite">
            내 기록 {total.toLocaleString()}개
          </p>
          <button className="primary" type="submit">
            검색
          </button>
          {catalog.loading && !catalog.items.length && (
            <p role="status">자료를 불러오고 있습니다…</p>
          )}
          {catalog.error && (
            <p role="alert">
              {catalog.error}
              <button onClick={catalog.reload}>다시 조회</button>
            </p>
          )}
        </form>
        <AssistLauncher
          library={library}
          scope={query}
          ownerId={ownerId}
          onOpen={onOpen}
          onAdopt={() => {
            void onUpdated();
          }}
        />
        <div className="thought-card-grid">
          {shown.map((m) => (
            <article className="panel thought-card" key={m.kind + m.id}>
              <small>
                {m.noteType
                  ? noteKindNames[m.noteType as keyof typeof noteKindNames]
                  : "내 기록"}{" "}
                · {categoryName(m.category)}
              </small>
              <button
                className="thought-title"
                onClick={() => onOpen(m.kind, m.id)}
              >
                {m.title || m.text.split("\n")[0].slice(0, 60) || "메모"}
              </button>
              {m.kind === "note" && m.bookTitle && (
                <small className="topic-book-title">{m.bookTitle}</small>
              )}
              <p>
                {m.text.slice(0, 350)}
                {m.text.length > 350 ? "…" : ""}
              </p>
              <div className="note-card-tags">
                {(m.tags ?? []).map((t) => (
                  <span key={t}>#{t}</span>
                ))}
              </div>
              <div className="topic-chips">
                {(m.topicIds ?? assigned(m).map((a) => a.topicId)).map(
                  (id, i) => {
                    const direct = assigned(m).find((a) => a.topicId === id);
                    return (
                      <span key={id}>
                        {direct?.status === "suggested" ? "제안: " : ""}
                        {m.kind === "note" && !direct ? "책 주제: " : ""}
                        {m.topicNames?.[i] ??
                          state.topics.find((t) => t.id === id)?.name}
                      </span>
                    );
                  },
                )}
              </div>
              <details>
                <summary>주제 분류</summary>
                <TopicPicker
                  topics={orderedTopics}
                  memberships={state.memberships}
                  source={m}
                  send={send}
                  busy={busy}
                />
              </details>
            </article>
          ))}
        </div>
        {!catalog.loading && !shown.length && (
          <p>해당 자료가 없습니다. 다른 주제나 미분류 자료를 확인해 보세요.</p>
        )}
        <div className="topic-material-pagination">
          <PageNavigation
            label="내 기록"
            paging={paging}
            total={total}
            busy={catalog.loading || !!catalog.error}
          />
          <PageSizeSelect label="내 기록" paging={paging} />
        </div>
        <section className="panel">
          <h3>주제 사이의 연결</h3>
          <p>서로 다른 원자료의 근거가 있을 때만 연결을 제안합니다.</p>
          {state.topicLinks.map((l) => (
            <div className="topic-link" key={l.id}>
              <strong>
                {state.topics.find((t) => t.id === l.sourceTopicId)?.name} ↔{" "}
                {state.topics.find((t) => t.id === l.targetTopicId)?.name}
              </strong>
              <p>
                {l.status === "accepted"
                  ? "확인한 연결"
                  : l.status === "rejected"
                    ? "거절한 연결"
                    : "검토할 연결"}
              </p>
              {l.supportingPairs.map((p, i) => (
                <div key={i}>
                  {[...new Set([p.beforeId, p.afterId])].map((id) => {
                    const n = library.notes.find((n) => n.id === id),
                      b = library.books.find((b) => b.id === id);
                    return (
                      <button
                        key={id}
                        onClick={() => onOpen(n ? "note" : "book", id)}
                      >
                        {n?.title ?? b?.title ?? "근거 자료"}
                      </button>
                    );
                  })}
                </div>
              ))}
              <button
                disabled={busy}
                onClick={() =>
                  void send("decideTopicLink", {
                    id: l.id,
                    expectedVersion: l.version,
                    status: "accepted",
                  })
                }
              >
                연결 확인
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  void send("decideTopicLink", {
                    id: l.id,
                    expectedVersion: l.version,
                    status: "rejected",
                  })
                }
              >
                연결 거절
              </button>
            </div>
          ))}
        </section>
      </div>
      <TopicManager
        state={state}
        topics={orderedTopics}
        selected={selected}
        onSelect={(id) => change("topics", id === "all" ? [] : [id])}
        onMove={moveTopic}
        send={send}
        busy={busy}
        error={error}
      />
      {onSaveNote && (
        <div className="topic-notes-trash">
          <NoteTrash library={library} onSave={onSaveNote} />
        </div>
      )}
    </div>
  );
}
