"use client";
import { libraryRequest } from "@/client/replica/request";
import { useEffect, useState } from "react";
import {
  useListPagination,
  PageSizeSelect,
  PageNavigation,
} from "./list-pagination";
import { reviewFields } from "../lib/catalog-review";
const labels = {
  title: "제목",
  author: "저자",
  publisher: "출판사",
  isbn: "ISBN",
  coverUrl: "표지 주소",
};
const reasonLabels: Record<string, string> = {
  isbn: "ISBN 확인",
  title: "제목·판본 확인",
  author: "저자 확인",
  publisher: "출판사 확인",
  source_changed: "수정된 도서정보 재확인",
};
export function CatalogReviewPanel({
  onChanged,
}: {
  onChanged: () => Promise<void>;
}) {
  const [status, setStatus] = useState("pending"),
    [q, setQ] = useState(""),
    [page, setPage] = useState<any>(null),
    [detail, setDetail] = useState<any>(null),
    [fields, setFields] = useState<string[]>([]),
    [confirmed, setConfirmed] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0);
  const paging = useListPagination(
    "catalog-reviews",
    JSON.stringify([status, q]),
  );
  const offset = paging.offset;
  const [summary, setSummary] = useState<any>(null);
  useEffect(() => {
    const c = new AbortController();
    libraryRequest("/api/catalog-review?summary=1", {
      signal: c.signal,
      cache: "no-store",
    }, {preferServer:true})
      .then(async (r) => {
        if (r.ok) setSummary(await r.json());
      })
      .catch(() => {});
    return () => c.abort();
  }, [revision]);
  useEffect(() => {
    if (!paging.ready) return;
    setError("");
    const c = new AbortController();
    setPage(null);
    libraryRequest(
      `/api/catalog-review?${new URLSearchParams({ status, q, offset: String(offset), limit: String(paging.size), groupBy: "book" })}`,
      { signal: c.signal, cache: "no-store" },
    )
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw Error(j.error);
        setPage(j);
      })
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => c.abort();
  }, [status, q, offset, revision, paging.ready, paging.size]);
  async function open(id: string) {
    setBusy(true);
    setError("");
    setDetail(null);
    try {
      const r = await libraryRequest(`/api/catalog-review?id=${id}`, {
          cache: "no-store",
        }),
        j = await r.json();
      if (!r.ok) throw Error(j.error);
      setDetail(j);
      setFields(reviewFields.filter((k) => !j.current[k] && j.record.facts[k]));
      setConfirmed(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function decide(action: string) {
    setBusy(true);
    setError("");
    try {
      const r = await libraryRequest("/api/catalog-review", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: detail.id,
            expectedVersion: detail.version,
            requestId: crypto.randomUUID(),
            action,
            sameEdition: confirmed,
            fields,
          }),
        }),
        j = await r.json();
      if (!r.ok) throw Error(j.error);
      setDetail(null);
      setRevision((n) => n + 1);
      if (action === "apply")
        void onChanged().catch((e) => setError(e.message));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="catalog-review">
      <p>
        확인 대기는 검토할 후보가 있는 도서 수입니다. 전체 미완료 도서 수와
        다릅니다.
      </p>
      {summary && (
        <div style={{ overflowX: "auto" }}>
          <table>
            <caption>
              형식별 도서정보 현황 · 여러 형식의 책은 각 형식에 포함
            </caption>
            <thead>
              <tr>
                {[
                  "형식",
                  "전체",
                  "표시 가능한 표지",
                  "분류 지정",
                  "공식 검증 분류",
                  "확인 대기 도서",
                  "검토 후보",
                  "보완 완료 표시 없음",
                ].map((t) => (
                  <th key={t}>{t}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {summary.formats.map((s: any) => (
                <tr key={s.format}>
                  <th>
                    {
                      (
                        {
                          paper: "종이책",
                          logos: "로고스",
                          ebook: "전자책",
                          pdf: "PDF",
                        } as any
                      )[s.format]
                    }
                  </th>
                  {[
                    "total",
                    "covers",
                    "classified",
                    "verified",
                    "reviewBooks",
                    "candidates",
                    "incomplete",
                  ].map((k) => (
                    <td key={k}>{s[k]}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            분류 지정에는 임시 분류가 포함됩니다. 보완 완료 표시 없음은 오류
            건수가 아닙니다.
          </p>
          <a href="/logos/covers">로고스 표지 후보 확인</a>
        </div>
      )}
      <div className="catalog-controls">
        <label>
          상태
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              paging.setPage(0);
              setDetail(null);
            }}
          >
            {[
              ["pending", "확인 필요한 책"],
              ["deferred", "보류"],
              ["applied", "반영"],
              ["rejected", "거절"],
              ["superseded", "이전 후보"],
            ].map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label>
          책 검색
          <input
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              paging.setPage(0);
            }}
          />
        </label>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {detail ? (
        <>
          <h3>{detail.current.title}</h3>
          {detail.alternatives?.length > 1 && (
            <label>
              비교할 후보
              <select
                value={detail.id}
                disabled={busy}
                onChange={(e) => void open(e.target.value)}
              >
                {detail.alternatives.map((a: any) => (
                  <option key={a.id} value={a.id}>
                    {a.title} · {a.author} · {a.publisher} · {a.isbn}
                  </option>
                ))}
              </select>
            </label>
          )}
          {detail.decision?.precheck?.reasons?.length > 0 && (
            <p>
              {detail.decision.precheck.reasons
                .map((r: string) => reasonLabels[r] ?? "정보 확인")
                .join(" · ")}
            </p>
          )}
          <div className="review-table-wrap">
            <table className="review-table">
              <thead>
                <tr>
                  <th>반영</th>
                  <th>항목</th>
                  <th>현재 정보</th>
                  <th>예스24 후보</th>
                </tr>
              </thead>
              <tbody>
                {reviewFields.map((k) => (
                  <tr key={k}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`${labels[k]} 반영`}
                        checked={fields.includes(k)}
                        disabled={!detail.record.facts[k]}
                        onChange={(e) =>
                          setFields((f) =>
                            e.target.checked
                              ? [...f, k]
                              : f.filter((x) => x !== k),
                          )
                        }
                      />
                    </td>
                    <th>{labels[k]}</th>
                    <td>{detail.current[k] || "—"}</td>
                    <td>{detail.record.facts[k] || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details>
            <summary>목차·소개와 출처</summary>
            <p>{detail.record.description}</p>
            <ol>
              {detail.record.toc?.map((t: string, i: number) => (
                <li key={i}>{t}</li>
              ))}
            </ol>
            <a href={detail.record.url} target="_blank" rel="noreferrer">
              예스24에서 판본 확인
            </a>
          </details>
          {["pending", "deferred"].includes(detail.status) && (
            <>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                소장본과 같은 판본으로 확인했습니다.
              </label>
              <div className="button-row">
                <button
                  disabled={busy || !confirmed || !fields.length}
                  className="primary"
                  onClick={() => void decide("apply")}
                >
                  선택 정보 반영
                </button>
                <button disabled={busy} onClick={() => void decide("defer")}>
                  보류
                </button>
                <button disabled={busy} onClick={() => void decide("reject")}>
                  후보 거절
                </button>
              </div>
            </>
          )}
          <button onClick={() => setDetail(null)}>목록으로</button>
        </>
      ) : page ? (
        <>
          <PageSizeSelect label="도서정보 검토" paging={paging} />
          <p>{page.total.toLocaleString()}권</p>
          <ul className="review-list">
            {page.items.map((i: any) => (
              <li key={i.id}>
                <button disabled={busy} onClick={() => void open(i.id)}>
                  <strong>{i.title}</strong>
                  <span>
                    {i.candidate_title} · {i.isbn}
                    {i.candidateCount > 1
                      ? ` · 후보 ${i.candidateCount}개`
                      : ""}
                  </span>
                  {i.precheck?.reasons?.length > 0 && (
                    <small>
                      {i.precheck.reasons
                        .map((r: string) => reasonLabels[r] ?? "정보 확인")
                        .join(" · ")}
                    </small>
                  )}
                </button>
              </li>
            ))}
          </ul>
          {page.total === 0 && <p>이 상태의 후보가 없습니다.</p>}
          <PageNavigation
            label="도서정보 검토"
            paging={paging}
            total={page.total}
            busy={busy || !!error}
          />
        </>
      ) : (
        <p role="status">불러오는 중…</p>
      )}
    </section>
  );
}
