"use client";
import { useState, useMemo } from "react";
import type { Library } from "@/lib/domain";
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
export function TopicBrowser({
  library,
  state,
  send,
  busy,
  error = "",
  onOpen,
  ownerId = "",
}: {
  library: Library;
  state: ThoughtMapSnapshot;
  send: ThoughtSend;
  busy: boolean;
  error?: string;
  onOpen: (kind: string, id: string) => void;
  ownerId?: string;
}) {
  const [selected, setSelected] = useState("all"),
    [field, setField] = useState("all"),
    [kind, setKind] = useState("note"),
    [search, setSearch] = useState(""),
    [sort, setSort] = useState("newest");
  const replica = useReplicaOptional();
  const { topics: orderedTopics, move: moveTopic } = useTopicOrder(
    state.topics,
    ownerId || replica?.runtime?.owner || "preview",
  );
  const paging = useListPagination(
    "topic-materials",
    JSON.stringify([selected, field, kind, sort, search]),
  );
  const query = useMemo(
    () => ({
      category: field,
      q: search,
      kind,
      topic: selected,
      sort,
      limit: paging.size,
      offset: paging.offset,
    }),
    [field, kind, selected, sort, search, paging.size, paging.offset],
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
        <div className="panel thought-filters topic-material-filters">
          <label>
            자료 종류
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="note">내 기록</option>
              <option value="book">책</option>
              <option value="all">책과 내 기록</option>
            </select>
          </label>
          <label>
            도서 분야
            <select value={field} onChange={(e) => setField(e.target.value)}>
              <option value="all">모든 분야</option>
              <option value="unclassified">미분류</option>
              {categories.map(([c, n]) => (
                <option key={c} value={c}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label>
            주제
            <select
              aria-label="주제"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
            >
              <option value="all">전체 주제</option>
              <option value="unclassified">미분류</option>
              {orderedTopics.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {!t.confirmed ? " · 제안" : ""}
                </option>
              ))}
            </select>
          </label>
          <label>
            정렬
            <select value={sort} onChange={(e) => setSort(e.target.value)}>
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
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="제목·내용 검색"
            />
          </label>
          <PageSizeSelect label="주제별 자료" paging={paging} />
          <p className="topic-material-count" aria-live="polite">
            {kind === "note"
              ? "내 기록"
              : kind === "book"
                ? "책"
                : "책과 내 기록"}{" "}
            {total.toLocaleString()}
            {kind === "book" ? "권" : "개"}
          </p>
          {catalog.loading && <p role="status">자료를 불러오고 있습니다…</p>}
          {catalog.error && (
            <p role="alert">
              {catalog.error}
              <button onClick={catalog.reload}>다시 조회</button>
            </p>
          )}
        </div>
        <div className="thought-card-grid">
          {shown.map((m) => (
            <article className="panel thought-card" key={m.kind + m.id}>
              <small>
                {m.kind === "book" ? "소장 도서" : "내 기록"} ·{" "}
                {categoryName(m.category)}
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
        <PageNavigation
          label="주제별 자료"
          paging={paging}
          total={total}
          busy={catalog.loading || !!catalog.error}
        />
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
        onSelect={setSelected}
        onMove={moveTopic}
        send={send}
        busy={busy}
        error={error}
      />
    </div>
  );
}
