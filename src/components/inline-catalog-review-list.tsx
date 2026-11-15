"use client";
import { useState, useRef } from "react";
import { libraryRequest } from "@/client/replica/request";
import { reviewFields, reviewValue } from "@/lib/catalog-review";
const labels = {
  title: "제목",
  author: "저자",
  publisher: "출판사",
  isbn: "ISBN",
  coverUrl: "표지",
  description: "소개",
  toc: "목차",
};
type Choice = {
  candidateId: string;
  reviewVersion: number;
  fields: string[];
};
export function InlineCatalogReviewList({
  items,
  onFinished,
  loading = false,
  onWorking,
}: {
  items: any[];
  onFinished: () => Promise<void>;
  loading?: boolean;
  onWorking?: (busy: boolean) => void;
}) {
  const [choices, setChoices] = useState<Record<string, Choice>>({}),
    [selected, setSelected] = useState<Record<string, boolean>>({}),
    [errors, setErrors] = useState<Record<string, string>>({}),
    [working, setWorking] = useState(false),
    [notice, setNotice] = useState("");
  const pending = useRef(false),
    requests = useRef(new Map<string, string>());
  function model(item: any) {
    const options = item.alternatives ?? [];
    const old = choices[item.book_id];
    const candidate =
      options.find((a: any) => (a.candidateKey ?? a.id) === old?.candidateId) ??
      options.find((a: any) => a.id === item.id) ??
      options[0];
    if (!candidate) return null;
    return {
      candidate,
      choice:
        old &&
        old.candidateId === (candidate.candidateKey ?? candidate.id) &&
        old.reviewVersion === candidate.version
          ? old
          : {
              candidateId: candidate.candidateKey ?? candidate.id,
              reviewVersion: candidate.version,
              fields: reviewFields.filter(
                (k) =>
                  !candidate.current.protectedFields?.includes(k) &&
                  !candidate.current[k]?.length &&
                  reviewValue(candidate.record, k)?.length,
              ),
            },
    };
  }
  function update(item: any, patch: Partial<Choice>) {
    const m = model(item);
    if (m)
      setChoices((old) => ({
        ...old,
        [item.book_id]: { ...m.choice, ...patch },
      }));
  }
  async function decide(action: "apply" | "reject" | "defer", rows: any[]) {
    if (pending.current) return;
    if (
      action === "apply" &&
      rows.some((i) => {
        const m = model(i);
        return !m || !m.choice.fields.length;
      })
    ) {
      setNotice("각 도서의 반영 항목을 선택해 주세요.");
      return;
    }
    pending.current = true;
    setWorking(true);
    onWorking?.(true);
    setNotice("");
    let success = 0;
    try {
      for (const item of rows) {
        const m = model(item);
        if (!m) continue;
        setErrors((old) => ({ ...old, [item.book_id]: "" }));
        try {
          const key = JSON.stringify([
            m.candidate.candidateKey ?? m.candidate.id,
            m.candidate.version,
            action,
            m.choice.fields,
          ]);
          const requestId = requests.current.get(key) ?? crypto.randomUUID();
          requests.current.set(key, requestId);
          const r = await libraryRequest("/api/catalog-review", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              id: m.candidate.id,
              candidateKey: m.candidate.candidateKey,
              expectedVersion: m.candidate.version,
              requestId,
              action,
              rejectAll: action === "reject",
              fields: m.choice.fields,
            }),
          });
          const result = await r.json();
          if (!r.ok) throw Error(result.error ?? "반영 실패");
          success++;
          setSelected((old) => ({ ...old, [item.book_id]: false }));
        } catch (e) {
          setErrors((old) => ({
            ...old,
            [item.book_id]: e instanceof Error ? e.message : "반영 실패",
          }));
        }
      }
      setNotice(
        `처리 ${success}권 · 실패 ${rows.length - success}권. 실패 항목은 선택과 입력을 유지합니다.`,
      );
      if (success) await onFinished();
    } finally {
      pending.current = false;
      setWorking(false);
      onWorking?.(false);
    }
  }
  const busy = working || loading,
    chosen = items.filter((i) => selected[i.book_id]),
    editable = items.some((i) =>
      ["pending", "deferred"].includes(model(i)?.candidate.status),
    );
  return (
    <div className="inline-catalog-reviews">
      <div className="logos-cover-bulk">
        <label>
          <input
            type="checkbox"
            aria-label="검토 목록 전체 선택"
            disabled={busy || !items.length}
            checked={
              items.length > 0 && items.every((i) => selected[i.book_id])
            }
            onChange={(e) =>
              setSelected(
                Object.fromEntries(
                  items.map((i) => [i.book_id, e.target.checked]),
                ),
              )
            }
          />{" "}
          전체 선택
        </label>
        <button
          className="primary compact-link"
          disabled={busy || !chosen.length || !editable}
          onClick={() => void decide("apply", chosen)}
        >
          {working ? "처리 중…" : `일괄 적용 (${chosen.length}권)`}
        </button>
        <button
          className="secondary compact-link"
          disabled={busy || !chosen.length || !editable}
          onClick={() => void decide("reject", chosen)}
        >
          일괄 거절 ({chosen.length}권)
        </button>
        <span>도서별 반영 항목과 판본을 확인한 뒤 적용하세요.</span>
      </div>
      {notice && <p role="status">{notice}</p>}
      <ul className="inline-review-list">
        {items.map((item) => {
          const m = model(item);
          if (!m)
            return (
              <li key={item.id}>
                {item.title} · 후보 정보를 불러오지 못했습니다.
              </li>
            );
          const { candidate: c, choice } = m;
          const facts = c.record.facts;
          const cover = facts.coverUrl || c.current.coverUrl;
          return (
            <li key={item.book_id} className="inline-review-card">
              <div className="inline-review-picture">
                <input
                  type="checkbox"
                  aria-label={c.current.title + " 선택"}
                  checked={!!selected[item.book_id]}
                  disabled={busy}
                  onChange={(e) =>
                    setSelected((old) => ({
                      ...old,
                      [item.book_id]: e.target.checked,
                    }))
                  }
                />
                {cover && /^(https:\/\/|\/api\/book-covers\/)/.test(cover) ? (
                  <img
                    src={cover}
                    alt={c.record.title + " 표지 후보"}
                    width={56}
                    height={80}
                  />
                ) : (
                  <span className="muted">표지 없음</span>
                )}
              </div>
              <div className="inline-review-info">
                <h3>{c.current.title}</h3>
                <p className="muted">
                  현재:{" "}
                  {[c.current.author, c.current.publisher, c.current.isbn]
                    .filter(Boolean)
                    .join(" · ") || "등록 정보 없음"}
                </p>
                {item.alternatives.length > 1 ? (
                  <label className="inline-review-candidate">
                    후보
                    <select
                      aria-label={c.current.title + " 비교할 후보"}
                      disabled={busy}
                      value={c.candidateKey ?? c.id}
                      onChange={(e) => {
                        const next = item.alternatives.find(
                          (a: any) =>
                            (a.candidateKey ?? a.id) === e.target.value,
                        );
                        setChoices((old) => ({
                          ...old,
                          [item.book_id]: {
                            candidateId: next.candidateKey ?? next.id,
                            reviewVersion: next.version,
                            fields: reviewFields.filter(
                              (k) =>
                                !next.current.protectedFields?.includes(k) &&
                                !next.current[k]?.length &&
                                reviewValue(next.record, k)?.length,
                            ),
                          },
                        }));
                      }}
                    >
                      {item.alternatives.map((a: any) => (
                        <option
                          key={a.candidateKey ?? a.id}
                          value={a.candidateKey ?? a.id}
                        >
                          {a.record.title} · {a.record.facts.author} ·{" "}
                          {a.record.isbn}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <strong>{c.record.title}</strong>
                )}
                <p>
                  {[facts.author, facts.publisher, c.record.isbn]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
                <div className="inline-review-fields">
                  {reviewFields.map((k) => (
                    <label key={k} className="inline-review-field">
                      <span className="inline-review-field-name">
                        <input
                          type="checkbox"
                          aria-label={
                            c.current.title + " " + labels[k] + " 반영"
                          }
                          disabled={
                            busy ||
                            !reviewValue(c.record, k)?.length ||
                            c.current.protectedFields?.includes(k) ||
                            !["pending", "deferred"].includes(c.status)
                          }
                          checked={choice.fields.includes(k)}
                          onChange={(e) =>
                            update(item, {
                              fields: e.target.checked
                                ? [...choice.fields, k]
                                : choice.fields.filter((x) => x !== k),
                            })
                          }
                        />
                        {labels[k]}
                      </span>
                      <span
                        className="muted"
                        style={{
                          display: "block",
                          whiteSpace: "pre-wrap",
                          overflowWrap: "anywhere",
                          maxHeight: 120,
                          overflow: "auto",
                        }}
                      >
                        현재:{" "}
                        {k === "coverUrl"
                          ? c.current[k]
                            ? "등록됨"
                            : "없음"
                          : Array.isArray(c.current[k])
                            ? c.current[k].join("\n")
                            : c.current[k] || "없음"}
                      </span>
                      <span
                        style={{
                          display: "block",
                          whiteSpace: "pre-wrap",
                          overflowWrap: "anywhere",
                          maxHeight: 120,
                          overflow: "auto",
                        }}
                      >
                        후보:{" "}
                        {k === "coverUrl"
                          ? reviewValue(c.record, k)
                            ? "표지 후보"
                            : "없음"
                          : Array.isArray(reviewValue(c.record, k))
                            ? reviewValue(c.record, k).join("\n")
                            : reviewValue(c.record, k) || "없음"}
                      </span>
                    </label>
                  ))}
                </div>
                <div className="compact-page-nav">
                  {["pending", "deferred"].includes(c.status) && (
                    <>
                      <button
                        className="primary compact-link"
                        disabled={busy || !choice.fields.length}
                        onClick={() => void decide("apply", [item])}
                      >
                        적용
                      </button>
                      <button
                        className="secondary compact-link"
                        disabled={busy}
                        onClick={() => void decide("defer", [item])}
                      >
                        보류
                      </button>
                      <button
                        className="secondary compact-link"
                        disabled={busy}
                        onClick={() => void decide("reject", [item])}
                      >
                        거절
                      </button>
                    </>
                  )}
                  {c.record.url?.startsWith("https://") && (
                    <a
                      className="secondary compact-link"
                      href={c.record.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      출처
                    </a>
                  )}
                </div>
                {errors[item.book_id] && (
                  <p className="error" role="alert">
                    {errors[item.book_id]}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
