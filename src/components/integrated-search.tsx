"use client";
import { useState } from "react";
import {
  useListPagination,
  PageSizeSelect,
  PageNavigation,
} from "./list-pagination";
import { usePagedResource } from "./use-paged-resource";
import type { SearchHit } from "@/server/library-search";
export function IntegratedSearch({
  onOpen,
}: {
  onOpen: (kind: string, id: string) => void;
}) {
  const [text, setText] = useState(""),
    [submitted, setSubmitted] = useState(""),
    [searched, setSearched] = useState(false),
    [revision, setRevision] = useState(0);
  const paging = useListPagination("search", submitted);
  const result = usePagedResource<{ items: SearchHit[]; total: number }>(
    "/api/library-search?" +
      new URLSearchParams({
        text: submitted,
        layer: "all",
        offset: String(paging.offset),
        limit: String(paging.size),
      }),
    searched && paging.ready,
    revision,
  );
  const hits = result.data?.items ?? [],
    busy = result.loading;
  return (
    <section className="integrated-search">
      <form
        className="integrated-search-form"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(text.trim());
          paging.setPage(0);
          setSearched(true);
          setRevision((n) => n + 1);
        }}
      >
        <label>
          검색
          <input
            type="search"
            aria-label="통합 검색어"
            placeholder="책, 저자, 내 생각을 검색하세요"
            value={text}
            maxLength={200}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <button className="primary" disabled={busy}>
          검색
        </button>
      </form>
      {result.error && (
        <p role="alert" className="error">
          {result.error}
        </p>
      )}
      {searched && !busy && !result.error && !hits.length && (
        <p role="status">조건에 맞는 자료가 없습니다.</p>
      )}
      <PageSizeSelect label="통합 검색" paging={paging} />
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
      {searched && (
        <PageNavigation
          label="통합 검색"
          paging={paging}
          total={result.data?.total ?? 0}
          busy={busy || !!result.error}
        />
      )}
    </section>
  );
}
