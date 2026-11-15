"use client";
import { libraryRequest } from "@/client/replica/request";
import { useEffect, useState } from "react";
import {
  useListPagination,
  PageSizeSelect,
  PageNavigation,
} from "./list-pagination";
import { InlineCatalogReviewList } from "./inline-catalog-review-list";

export function CatalogReviewPanel({
  onChanged,
}: {
  onChanged: () => Promise<void>;
}) {
  const [format, setFormat] = useState("pdf"),
    [status, setStatus] = useState("pending"),
    [q, setQ] = useState(""),
    [page, setPage] = useState<any>(null),
    [summary, setSummary] = useState<any>(null),
    [error, setError] = useState(""),
    [revision, setRevision] = useState(0),
    [loading, setLoading] = useState(false),
    [operationBusy, setOperationBusy] = useState(false);
  const paging = useListPagination(
    "catalog-reviews",
    JSON.stringify([format, status, q]),
  );
  useEffect(() => {
    const c = new AbortController();
    libraryRequest(
      "/api/catalog-review?summary=1",
      { signal: c.signal, cache: "no-store" },
      { preferServer: true },
    )
      .then(async (r) => {
        if (r.ok) setSummary(await r.json());
      })
      .catch(() => {});
    return () => c.abort();
  }, [revision]);
  useEffect(() => {
    if (!paging.ready) return;
    const c = new AbortController();
    setLoading(true);
    setError("");
    libraryRequest(
      "/api/catalog-review?" +
        new URLSearchParams({
          status,
          q,
          format,
          inline: "1",
          offset: String(paging.offset),
          limit: String(paging.size),
          groupBy: "book",
        }),
      { signal: c.signal, cache: "no-store" },
    )
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw Error(data.error);
        setPage(data);
      })
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      })
      .finally(() => {
        if (!c.signal.aborted) setLoading(false);
      });
    return () => c.abort();
  }, [format, status, q, revision, paging.ready, paging.offset, paging.size]);
  async function changed() {
    setRevision((n) => n + 1);
    try {
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function chooseFormat(value: string) {
    setFormat(value);
    setPage(null);
    setError("");
    paging.setPage(0);
  }
  return (
    <section className="catalog-review">
      <p>
        확인 대기는 검토할 후보가 있는 도서 수입니다. 전체 미완료 도서 수와
        다릅니다.
      </p>
      {summary && (
        <div className="catalog-summary">
          <div
            className="catalog-summary-scroll"
            role="region"
            aria-label="형식별 도서정보 현황"
            tabIndex={0}
          >
            <table className="catalog-summary-table">
              <caption>형식별 도서정보 현황</caption>
              <thead>
                <tr>
                  {[
                    "형식",
                    "전체",
                    "표지",
                    "분류",
                    "공식 분류",
                    "확인 대기",
                    "후보",
                    "보완 미표시",
                  ].map((t) => (
                    <th key={t} scope="col">
                      {t}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {summary.formats.map((s: any) => (
                  <tr key={s.format}>
                    <th scope="row">
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
          </div>
          <p>
            여러 형식의 책은 각 형식에 포함됩니다. 분류에는 임시 분류가
            포함됩니다. 보완 미표시는 오류 건수가 아닙니다.
          </p>
        </div>
      )}

      <div
        className="catalog-format-tabs"
        role="tablist"
        aria-label="검토할 소장 형식"
      >
        {[
          ["pdf", "PDF"],
          ["logos", "로고스"],
          ["ebook", "전자책"],
          ["paper", "종이책"],
          ...(summary?.residualReviewBooks > 0 ? [["other", "기타도서"]] : []),
        ].map(([value, label]) => (
          <button
            key={value}
            role="tab"
            aria-selected={format === value}
            className={
              format === value
                ? "primary compact-link"
                : "secondary compact-link"
            }
            disabled={operationBusy}
            onClick={() => chooseFormat(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {
        <>
          <div className="catalog-controls">
            <label>
              상태
              <select
                disabled={operationBusy}
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value);
                  setPage(null);
                  paging.setPage(0);
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
                disabled={operationBusy}
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setPage(null);
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
          {page ? (
            <>
              <p>{page.total.toLocaleString()}권</p>
              <InlineCatalogReviewList
                key={JSON.stringify([format, status, q, paging.offset])}
                items={page.items}
                loading={loading}
                onWorking={setOperationBusy}
                onFinished={changed}
              />
              {page.total === 0 && <p>이 상태의 후보가 없습니다.</p>}
              <div className="catalog-review-paging">
                <PageNavigation
                  label="도서정보 검토"
                  paging={paging}
                  total={page.total}
                  busy={loading || operationBusy || !!error}
                />
                <PageSizeSelect
                  label="도서정보 검토"
                  paging={paging}
                  disabled={operationBusy}
                />
              </div>
            </>
          ) : (
            <p role="status">불러오는 중…</p>
          )}
        </>
      }
    </section>
  );
}
