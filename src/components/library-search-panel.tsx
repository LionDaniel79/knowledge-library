"use client";
import { useState } from "react";
import type { SearchHit } from "@/server/library-search";
import type { SearchTopic } from "@/server/library-search-context";
export function LibrarySearchPanel({
  onOpen,
}: {
  onOpen: (kind: string, id: string) => void;
}) {
  const [text, setText] = useState(""),
    [layer, setLayer] = useState("all"),
    [hits, setHits] = useState<SearchHit[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [searched, setSearched] = useState(false);
  const [topicId, setTopicId] = useState(""),
    [topicScope, setTopicScope] = useState("exact"),
    [expandAliases, setExpandAliases] = useState(false),
    [topics, setTopics] = useState<SearchTopic[] | null>(null),
    [loadingTopics, setLoadingTopics] = useState(false);
  const [submitted, setSubmitted] = useState<Record<string, string>>({
    text: "",
    layer: "all",
  });
  async function loadTopics() {
    if (topics || loadingTopics) return;
    setLoadingTopics(true);
    try {
      const r = await fetch("/api/library-search/topics", {
          cache: "no-store",
        }),
        j = await r.json();
      if (!r.ok) throw Error(j.error ?? "주제를 불러오지 못했습니다.");
      setTopics(j.topics);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingTopics(false);
    }
  }
  async function search(more = false) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const query: Record<string, string> = more
        ? submitted
        : {
            text,
            layer,
            topicScope,
            expandAliases: String(expandAliases),
            ...(topicId ? { topicId } : {}),
          };
      const p = new URLSearchParams(query);
      if (more && cursor) p.set("cursor", cursor);
      const r = await fetch("/api/library-search?" + p, { cache: "no-store" }),
        j = await r.json();
      if (!r.ok) throw Error(j.error ?? "검색하지 못했습니다.");
      setHits((old) => (more ? [...old, ...j.items] : j.items));
      setCursor(j.nextCursor);
      setSubmitted(query);
      setSearched(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel library-search-panel">
      <h2>자료와 내 생각을 함께 찾기</h2>
      <p>내 글·책의 정보·검색용 정리 정보를 구분해서 찾습니다.</p>
      <form
        className="thought-filters"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <label>
          자료 검색어
          <input
            value={text}
            maxLength={200}
            onChange={(e) => setText(e.target.value)}
            placeholder="기억나는 문장, 제목, 주제"
          />
        </label>
        <details
          className="search-topic-options"
          onToggle={(e) => {
            if (e.currentTarget.open) void loadTopics();
          }}
        >
          <summary>주제와 다른 표현으로 찾기</summary>
          <label>
            주제
            <select
              value={topicId}
              onChange={(e) => setTopicId(e.target.value)}
              disabled={loadingTopics}
            >
              <option value="">모든 주제</option>
              {topics?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            주제 범위
            <select
              value={topicScope}
              onChange={(e) => setTopicScope(e.target.value)}
              disabled={!topicId}
            >
              <option value="exact">선택한 주제만</option>
              <option value="children">하위 주제도 포함</option>
              <option value="related">하위 주제와 연결한 주제 포함</option>
            </select>
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={expandAliases}
              onChange={(e) => setExpandAliases(e.target.checked)}
            />
            내가 정한 다른 표현도 검색
          </label>
          <p className="form-hint">
            사유의 지도에서 확인한 주제와 연결만 사용합니다. ‘다른 표현’은
            검색어 전체가 주제 이름이나 별칭과 일치할 때 함께 찾습니다.
          </p>
          {topics?.length === 0 && (
            <p className="muted">
              확인한 주제가 아직 없습니다. 사유의 지도에서 주제를 만들거나
              제안을 확인해 주세요.
            </p>
          )}
        </details>
        <label>
          검색 대상
          <select value={layer} onChange={(e) => setLayer(e.target.value)}>
            <option value="all">모두</option>
            <option value="mine">내 글과 판단</option>
            <option value="source">책 정보·인용·확인 전 기록</option>
            <option value="auxiliary">검색용 정리 정보</option>
          </select>
        </label>
        <button className="primary" disabled={busy}>
          {busy ? "검색 중…" : "자료 찾기"}
        </button>
      </form>
      <p className="form-hint">
        이 검색은 온라인에 저장된 목록과 기록을 찾습니다. PDF 본문은 원문이 있는
        PC의 ‘PDF 원문 검색’에서 찾을 수 있습니다.
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {searched && !hits.length && (
        <p role="status">조건에 맞는 자료가 없습니다.</p>
      )}
      <div className="search-hit-list">
        {hits.map((h) => (
          <article key={h.id}>
            <small>
              {h.layer === "mine"
                ? "내 글과 판단"
                : h.layer === "auxiliary"
                  ? "검색용 정리 정보"
                  : h.voice === "unconfirmed"
                    ? "누구의 말인지 확인 전"
                    : "책 정보·인용"}
            </small>
            <h3>
              <button onClick={() => onOpen(h.source.kind, h.source.id)}>
                {h.title}
              </button>
            </h3>
            <p>{h.quote}</p>
            <details>
              <summary>근거 보기</summary>
              {!!h.matchedTerms?.length && (
                <p>찾은 표현: {h.matchedTerms.join(" · ")}</p>
              )}
              {!!h.topicMatches?.length && (
                <p>
                  찾은 주제:{" "}
                  {h.topicMatches
                    .map(
                      (t) =>
                        `${t.name} (${t.relation === "exact" ? "선택한 주제" : t.relation === "child" ? "하위 주제" : "확인한 연결"})`,
                    )
                    .join(" · ")}
                </p>
              )}
              <p>
                {h.origin === "original"
                  ? "저장된 원자료"
                  : h.origin === "human"
                    ? "사용자 판단"
                    : "보조 정리 정보"}{" "}
                ·{" "}
                {h.coverage === "metadata"
                  ? "서지 범위"
                  : h.coverage === "partial"
                    ? "일부 내용"
                    : h.coverage === "toc"
                      ? "목차"
                      : "기록 범위"}
              </p>
            </details>
          </article>
        ))}
      </div>
      {cursor && (
        <button disabled={busy} onClick={() => void search(true)}>
          검색 결과 더 보기
        </button>
      )}
    </section>
  );
}
