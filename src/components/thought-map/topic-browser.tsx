"use client";
import { useState, useMemo } from "react";
import type { Library } from "@/lib/domain";
import { categories, categoryName, parseTags } from "@/lib/catalog";
import type { ThoughtMapSnapshot, Topic } from "@/lib/thought-map/types";
import { useBookCatalog } from "../use-book-catalog";
import { TopicPicker, type ThoughtSend } from "./topic-picker";
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
    [query, setQuery] = useState(""),
    [limit, setLimit] = useState(36);
  const [editing, setEditing] = useState<Topic | null>(null),
    [name, setName] = useState(""),
    [description, setDescription] = useState(""),
    [aliases, setAliases] = useState(""),
    [parentId, setParentId] = useState("");
  const catalog = useBookCatalog({
    enabled: !!library.catalog,
    query: {
      q: query,
      category: field || "all",
      topic: selected,
      sort: "title",
      limit: 36,
    },
    revision: state,
  });
  const materials = [
    ...library.notes.map((n) => ({
      id: n.id,
      kind: "note" as const,
      title: n.title,
      text: n.content,
      category: library.books.find((b) => b.id === n.bookId)?.category ?? "",
      version: n.version,
    })),
    ...(library.catalog ? catalog.items : library.books).map((b) => ({
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
      const key = m.sourceKind + ":" + m.sourceId;
      map.set(key, [...(map.get(key) ?? []), m]);
    }
    return map;
  }, [state.memberships]);
  const assigned = (m: (typeof materials)[number]) =>
    (membershipMap.get(m.kind + ":" + m.id) ?? []).filter(
      (a) => a.status !== "rejected",
    );
  const shown = materials.filter(
    (m) =>
      (m.kind === "book" && !!library.catalog) ||
      ((!field || m.category === field) &&
        (selected === "all" || selected === "unclassified"
          ? selected === "all" || assigned(m).length === 0
          : assigned(m).some((a) => a.topicId === selected)) &&
        (!query ||
          [m.title, m.text]
            .join(" ")
            .toLocaleLowerCase()
            .includes(query.toLocaleLowerCase()))),
  );
  function edit(t: Topic | null) {
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
            setLimit(36);
          }}
        >
          전체 자료
        </button>
        <button
          aria-pressed={selected === "unclassified"}
          onClick={() => {
            setSelected("unclassified");
            setLimit(36);
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
                setLimit(36);
              }}
            >
              {t.parentId ? "↳ " : ""}
              {t.name}
              {!t.confirmed ? " · 제안" : ""}
            </button>
            <button aria-label={`${t.name} 주제 수정`} onClick={() => edit(t)}>
              수정
            </button>
          </div>
        ))}
        <details open={editing ? true : undefined}>
          <summary>주제 만들기·수정</summary>
          <form
            className="thought-form"
            onSubmit={(e) => {
              e.preventDefault();
              void send("upsertTopic", {
                ...(editing
                  ? {
                      id: editing.id,
                      expectedVersion:
                        state.topics.find((t) => t.id === editing.id)
                          ?.version ?? editing.version,
                    }
                  : {}),
                name,
                description,
                aliases: parseTags(aliases),
                parentId: parentId || null,
                kdcCodes: editing?.kdcCodes ?? [],
              });
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
        </details>
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
                setLimit(36);
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
          <p>
            {library.catalog
              ? catalog.total + shown.filter((m) => m.kind === "note").length
              : shown.length}
            개 자료
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
          {shown.slice(0, limit).map((m) => (
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
        {(shown.length > limit || !!catalog.nextCursor) && (
          <button
            disabled={catalog.loading}
            onClick={() => {
              setLimit((n) => n + 36);
              if (library.catalog) void catalog.more();
            }}
          >
            자료 더 보기
          </button>
        )}
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
