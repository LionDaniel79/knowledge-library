"use client";
import { useEffect, useState } from "react";
import { reviewFields } from "../lib/catalog-review";
const labels = {
  title: "제목",
  author: "저자",
  publisher: "출판사",
  isbn: "ISBN",
  coverUrl: "표지 주소",
};
export function CatalogReviewPanel({
  onChanged,
}: {
  onChanged: () => Promise<void>;
}) {
  const [status, setStatus] = useState("pending"),
    [q, setQ] = useState(""),
    [offset, setOffset] = useState(0),
    [page, setPage] = useState<any>(null),
    [detail, setDetail] = useState<any>(null),
    [fields, setFields] = useState<string[]>([]),
    [confirmed, setConfirmed] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    const c = new AbortController();
    setPage(null);
    fetch(
      `/api/catalog-review?${new URLSearchParams({ status, q, offset: String(offset) })}`,
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
  }, [status, q, offset, revision]);
  async function open(id: string) {
    setBusy(true);
    setError("");
    setDetail(null);
    try {
      const r = await fetch(`/api/catalog-review?id=${id}`, {
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
      const r = await fetch("/api/catalog-review", {
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
      if (action === "apply") await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="catalog-review">
      <div className="catalog-controls">
        <label>
          상태
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setOffset(0);
              setDetail(null);
            }}
          >
            {[
              ["pending", "검토 대기"],
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
              setOffset(0);
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
          <p>{page.total.toLocaleString()}개 후보</p>
          <ul className="review-list">
            {page.items.map((i: any) => (
              <li key={i.id}>
                <button disabled={busy} onClick={() => void open(i.id)}>
                  <strong>{i.title}</strong>
                  <span>
                    {i.candidate_title} · {i.isbn}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {page.total === 0 && <p>이 상태의 후보가 없습니다.</p>}
          <div className="button-row">
            <button
              disabled={!offset}
              onClick={() => setOffset((n) => Math.max(0, n - 20))}
            >
              이전
            </button>
            <button
              disabled={page.nextOffset === null}
              onClick={() => setOffset(page.nextOffset)}
            >
              다음
            </button>
          </div>
        </>
      ) : (
        <p role="status">불러오는 중…</p>
      )}
    </section>
  );
}
