"use client";
import { useState, useMemo } from "react";
import type { Library } from "@/lib/domain";
import { categories, categoryName, parseTags } from "@/lib/catalog";
import type { ThoughtMapSnapshot, Topic } from "@/lib/thought-map/types";
import { useMaterialPage } from "../use-material-page";
import {
  useListPagination,
  PageSizeSelect,
  PageNavigation,
} from "../list-pagination";
import { TopicPicker, type ThoughtSend } from "./topic-picker";
import { Modal } from "../modal";
export function TopicBrowser({
  library,
  state,
  send,
  busy,
  onOpen,
}: {
  library: Library;
  state: ThoughtMapSnapshot;
  send: ThoughtSend;
  busy: boolean;
  onOpen: (kind: string, id: string) => void;
}) {
  const [selected, setSelected] = useState("all"),
    [field, setField] = useState(""),
    [query, setQuery] = useState("");
  const paging = useListPagination(
    "topic-materials",
    JSON.stringify([selected, field, query]),
  );
  const [formOpen, setFormOpen] = useState(false);
  const [deleting, setDeleting] = useState<Topic | null>(null);
  const [editing, setEditing] = useState<Topic | null>(null),
    [name, setName] = useState(""),
    [description, setDescription] = useState(""),
    [aliases, setAliases] = useState(""),
    [parentId, setParentId] = useState("");
  const catalog = useMaterialPage(
    !!library.catalog && paging.ready,
    {
      q: query,
      category: field || "all",
      topic: selected,
      limit: paging.size,
      offset: paging.offset,
    },
    state,
  );
  const materials = [
    ...library.notes.map((n) => ({
      id: n.id,
      kind: "note" as const,
      title: n.title,
      text: n.content,
      category: library.books.find((b) => b.id === n.bookId)?.category ?? "",
      version: n.version,
    })),
    ...library.books.map((b) => ({
      id: b.id,
      kind: "book" as const,
      title: b.title,
      text: [b.author, b.publisher].filter(Boolean).join(" · "),
      category: b.category ?? "",
      version: b.version,
    })),
  ];
  const membershipMap = useMemo(() => {
    const map = new Map<string, typeof state.memberships>();
    for (const m of state.memberships) {
      if (!state.topics.some((t) => t.id === m.topicId)) continue;
      const key = m.sourceKind + ":" + m.sourceId;
      map.set(key, [...(map.get(key) ?? []), m]);
    }
    return map;
  }, [state.memberships, state.topics]);
  const assigned = (m: (typeof materials)[number]) =>
    (membershipMap.get(m.kind + ":" + m.id) ?? []).filter(
      (a) => a.status !== "rejected",
    );
  const localShown = materials.filter(
    (m) =>
      (!field || m.category === field) &&
      (selected === "all" || selected === "unclassified"
        ? selected === "all" || assigned(m).length === 0
        : assigned(m).some((a) => a.topicId === selected)) &&
      (!query ||
        [m.title, m.text]
          .join(" ")
          .toLocaleLowerCase()
          .includes(query.toLocaleLowerCase())),
  );
  const total = library.catalog ? catalog.total : localShown.length;
  const shown = library.catalog
    ? catalog.items
    : localShown.slice(paging.offset, paging.offset + paging.size);
  function edit(t: Topic | null) {
    setFormOpen(true);
    setEditing(t);
    setName(t?.name ?? "");
    setDescription(t?.description ?? "");
    setAliases(t?.aliases.join(", ") ?? "");
    setParentId(t?.parentId ?? "");
  }
  return (
    <div className="thought-layout">
      <aside className="panel thought-topics">
        <h2>나의 주제</h2>
        <button disabled={busy} onClick={() => void send("proposeTopics", {})}>
          기존 태그로 주제 제안
        </button>
        <button
          aria-pressed={selected === "all"}
          onClick={() => {
            setSelected("all");
            paging.setPage(0);
          }}
        >
          전체 자료
        </button>
        <button
          aria-pressed={selected === "unclassified"}
          onClick={() => {
            setSelected("unclassified");
            paging.setPage(0);
          }}
        >
          미분류
          {!library.catalog
            ? " " + materials.filter((m) => assigned(m).length === 0).length
            : ""}
        </button>
        {state.topics.map((t) => (
          <div key={t.id} className="topic-row">
            <button
              aria-pressed={selected === t.id}
              onClick={() => {
                setSelected(t.id);
                paging.setPage(0);
              }}
            >
              {t.parentId ? "↳ " : ""}
              {t.name}
              {!t.confirmed ? " · 제안" : ""}
            </button>
            <button aria-label={`${t.name} 주제 수정`} onClick={() => edit(t)}>
              수정
            </button>
            <button
              disabled={busy}
              aria-label={`${t.name} 주제 삭제`}
              onClick={() => setDeleting(t)}
            >
              삭제
            </button>
          </div>
        ))}
        <button onClick={() => setFormOpen(true)}>주제 만들기·수정</button>
        {formOpen && (
          <Modal
            title={editing ? "주제 수정" : "주제 만들기"}
            onClose={() => setFormOpen(false)}
            canClose={!busy}
          >
            <form
              className="thought-form"
              onSubmit={async (e) => {
                e.preventDefault();
                const saved = await send("upsertTopic", {
                  ...(editing
                    ? {
                        id: editing.id,
                        expectedVersion: editing.version,
                      }
                    : {}),
                  name,
                  description,
                  aliases: parseTags(aliases),
                  parentId: parentId || null,
                  kdcCodes: editing?.kdcCodes ?? [],
                });
                if (saved) {
                  edit(null);
                  setFormOpen(false);
                }
              }}
            >
              <label>
                주제 이름
                <input
                  value={name}
                  maxLength={80}
                  required
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label>
                주제 설명
                <textarea
                  value={description}
                  maxLength={2000}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </label>
              <label>
                별칭 · 쉼표로 구분
                <input
                  value={aliases}
                  onChange={(e) => setAliases(e.target.value)}
                />
              </label>
              <label>
                상위 주제
                <select
                  value={parentId}
                  onChange={(e) => setParentId(e.target.value)}
                >
                  <option value="">상위 없음</option>
                  {state.topics
                    .filter((t) => t.id !== editing?.id)
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                </select>
              </label>
              <p className="form-hint">
                최대 3단계. 같은 별칭이 있어도 주제를 자동으로 합치지 않습니다.
              </p>
              <button className="primary" disabled={busy}>
                주제 저장
              </button>
              {editing && (
                <button type="button" onClick={() => edit(null)}>
                  새 주제 작성
                </button>
              )}
            </form>
          </Modal>
        )}
        {deleting && (
          <section className="notice" aria-label="주제 삭제 확인">
            <p>
              ‘{deleting.name}’ 주제를 목록에서 삭제할까요? 메모와 기존 판단은
              보존됩니다.
            </p>
            <button
              disabled={busy}
              onClick={async () => {
                if (
                  await send("deleteTopic", {
                    id: deleting.id,
                    expectedVersion: deleting.version,
                  })
                ) {
                  if (selected === deleting.id) setSelected("all");
                  if (editing?.id === deleting.id) {
                    edit(null);
                    setFormOpen(false);
                  }
                  setDeleting(null);
                }
              }}
            >
              주제 삭제
            </button>
            <button onClick={() => setDeleting(null)}>취소</button>
          </section>
        )}
        {!!state.archivedTopics?.length && (
          <details>
            <summary>삭제한 주제 · {state.archivedTopics.length}개</summary>
            {state.archivedTopics.map((t) => (
              <div key={t.id}>
                {t.name}
                <button
                  disabled={busy}
                  onClick={() =>
                    void send("restoreTopic", {
                      id: t.id,
                      expectedVersion: t.version,
                    })
                  }
                >
                  복원
                </button>
              </div>
            ))}
          </details>
        )}
      </aside>
      <div className="thought-materials">
        <div className="panel thought-filters">
          <strong>서지·내 기록 기반</strong>
          <p>
            도서관 분야와 개인 주제는 별개입니다. 책의 내용에 관한 근거는
            원문이나 내 기록에서 확인합니다.
          </p>
          <label>
            자료 찾기
            <input
              value={query}
              placeholder="책 제목·저자·기록 내용"
              onChange={(e) => {
                setQuery(e.target.value);
                paging.setPage(0);
              }}
            />
          </label>
          <label>
            도서관 분야
            <select value={field} onChange={(e) => setField(e.target.value)}>
              <option value="">모든 분야</option>
              {categories.map(([c, n]) => (
                <option key={c} value={c}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <p>{total}개 자료</p>
          <PageSizeSelect label="주제별 자료" paging={paging} />
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
                {m.kind === "book" ? "소장 도서 · 서지 정보" : "내 기록"} ·{" "}
                {categoryName(m.category)}
              </small>
              <button
                className="thought-title"
                onClick={() => onOpen(m.kind, m.id)}
              >
                {m.title}
              </button>
              <p>
                {m.text.slice(0, 350)}
                {m.text.length > 350 ? "…" : ""}
              </p>
              <div className="topic-chips">
                {assigned(m).map((a) => (
                  <span key={a.id}>
                    {a.status === "suggested" ? "제안: " : ""}
                    {state.topics.find((t) => t.id === a.topicId)?.name}
                  </span>
                ))}
              </div>
              <details>
                <summary>주제 분류</summary>
                <TopicPicker
                  topics={state.topics}
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
    </div>
  );
}
