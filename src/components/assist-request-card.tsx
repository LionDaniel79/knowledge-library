"use client";
import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { libraryRequest } from "@/client/replica/request";
import type { Library } from "@/lib/domain";
import type { SynthesisResult } from "@/lib/assist-synthesis";
import {
  thoughtRelationNames,
  type ThoughtRelation,
} from "@/lib/thought-map/types";
const statusNames: Record<string, string> = {
  queued: "처리 대기",
  claimed: "실행 준비",
  sending: "분석 중",
  completed: "제안 준비됨",
  failed: "실행 확인 필요",
  cancelled: "취소됨",
  stale: "자료 변경됨",
  cost_unknown: "비용 확인 필요",
};
const kindNames = {
  note_connection: "메모 연결",
  topic_connection: "주제 연결",
  new_topic: "새 주제",
  writing_idea: "글감 방향",
};
const adoptNames = {
  note_connection: "연결 확정",
  topic_connection: "주제 연결 확정",
  new_topic: "주제로 저장",
  writing_idea: "글감 묶음으로 저장",
};
const legacyNames: Record<string, string> = {
  organize_note: "기록 정리",
  tag_suggestion: "태그 제안",
  excerpt_explanation: "구절 설명",
  compare_notes: "기록 비교",
};
export function AssistRequestCard({
  request: r,
  busy,
  act,
  library,
  onOpen,
}: {
  request: any;
  busy: boolean;
  act: (action: string, payload: any) => Promise<any>;
  library: Library;
  onOpen?: (kind: string, id: string) => void;
}) {
  const [open, setOpen] = useState(false),
    [detail, setDetail] = useState<any>(null),
    [error, setError] = useState(""),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!open) return;
    const c = new AbortController();
    setError("");
    void libraryRequest(
      "/api/assist?id=" + r.id,
      { cache: "no-store", signal: c.signal },
      { preferServer: typeof navigator === "undefined" || navigator.onLine },
    )
      .then(async (response) => {
        const j = await response.json();
        if (!response.ok) throw Error(j.error ?? "제안을 열지 못했습니다.");
        if (!c.signal.aborted)
          setDetail(j.requests.find((v: any) => v.id === r.id) ?? null);
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(e.message);
      });
    return () => c.abort();
  }, [open, r.id, r.updated_at, r.status, revision]);
  const value = detail ?? r,
    adopted = (index: number) =>
      (value.adoption ?? r.adoption ?? []).some((a: any) => a.index === index);
  const canDelete = !["queued", "claimed", "sending", "cost_unknown"].includes(
    r.status,
  );
  async function adopt(index: number) {
    if (await act("adopt", { id: r.id, index })) setRevision((n) => n + 1);
  }
  const suggestions = (value.result?.output?.suggestions ??
    []) as SynthesisResult["suggestions"];
  const output = value.result?.output,
    legacyEvidence =
      r.purpose === "synthesis"
        ? []
        : [
            ...(output?.evidence ?? []),
            ...(output?.items ?? output?.tags ?? []).map(
              (v: any) => v.evidence,
            ),
            output?.before,
            output?.after,
          ].filter(Boolean);
  return (
    <article className="assist-request-row">
      <details
        onToggle={(e) => {
          if (e.target === e.currentTarget) setOpen(e.currentTarget.open);
        }}
      >
        <summary>
          <strong>
            {r.purpose === "synthesis"
              ? "사고 보조"
              : (legacyNames[r.purpose] ?? "AI 도움")}
          </strong>
          <time>{new Date(r.created_at).toLocaleDateString("ko-KR")}</time>
          <span>{statusNames[r.status] ?? r.status}</span>
        </summary>
        <div className="assist-request-detail">
          {error && (
            <p role="alert">
              {error}
              <button onClick={() => setRevision((n) => n + 1)}>
                다시 조회
              </button>
            </p>
          )}
          {!detail && !error && <p role="status">세부 내용 불러오는 중…</p>}
          {r.status === "failed" && (
            <p>
              처리를 완료하지 못했습니다. 연결·모델·사용 한도를 확인해 주세요.
            </p>
          )}
          {r.status === "stale" && (
            <p>원자료가 변경되어 이 제안은 채택할 수 없습니다.</p>
          )}
          {r.status === "completed" && value.result?.valid && (
            <>
              {suggestions.map((s, index) => (
                <section className="assist-suggestion" key={index}>
                  <small>{kindNames[s.kind]}</small>
                  <h4>{s.title}</h4>
                  <p>{s.reason}</p>
                  {!!s.outline.length && (
                    <ol>
                      {s.outline.map((v, i) => (
                        <li key={i}>{v}</li>
                      ))}
                    </ol>
                  )}
                  <button
                    disabled={busy || adopted(index)}
                    onClick={() => void adopt(index)}
                  >
                    {adopted(index) ? "저장함" : adoptNames[s.kind]}
                  </button>
                  <details>
                    <summary>근거 기록</summary>
                    {s.evidence.map((e, i) => {
                      const source = value.scope?.sources?.[e.sourceIndex];
                      return (
                        <div key={i}>
                          <blockquote>{e.quote}</blockquote>
                          {source && onOpen && (
                            <button onClick={() => onOpen("note", source.id)}>
                              {library.notes.find((n) => n.id === source.id)
                                ?.title || `원문 기록 ${e.sourceIndex + 1}`}
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </details>
                </section>
              ))}
              {r.purpose === "synthesis" && !suggestions.length && detail && (
                <p>확인할 만한 연결이나 새 글감을 찾지 못했습니다.</p>
              )}
              {(
                value.result.output?.items ??
                value.result.output?.tags ??
                []
              ).map((item: any, index: number) => (
                <p key={index}>
                  <span>
                    {item.kind === "topic" ? "주제" : "태그"}:{" "}
                    {item.value ?? item.tag}
                  </span>
                  <button
                    disabled={busy || adopted(index)}
                    onClick={() => void adopt(index)}
                  >
                    {adopted(index)
                      ? "저장함"
                      : item.kind === "topic"
                        ? "주제로 저장"
                        : "태그로 저장"}
                  </button>
                </p>
              ))}
              {value.result.output?.explanation && (
                <p>{value.result.output.explanation}</p>
              )}
              {r.purpose === "compare_notes" && output?.relation && (
                <p>
                  생각의 관계:{" "}
                  {thoughtRelationNames[output.relation as ThoughtRelation] ??
                    output.relation}
                </p>
              )}
              {!!legacyEvidence.length && (
                <details>
                  <summary>근거 기록</summary>
                  {legacyEvidence.map((e: any, i: number) => {
                    const id =
                      e.noteId ?? value.scope?.sources?.[e.sourceIndex]?.id;
                    return (
                      <div key={i}>
                        <blockquote>{e.quote}</blockquote>
                        {id && onOpen && (
                          <button onClick={() => onOpen("note", id)}>
                            {library.notes.find((n) => n.id === id)?.title ||
                              `원문 기록 ${i + 1}`}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </details>
              )}
            </>
          )}
          {r.status === "cost_unknown" && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                void act("resolveCost", {
                  id: r.id,
                  costUsd: String(f.get("cost")),
                });
              }}
            >
              <p>
                호출 여부가 불확실합니다. 사용 내역을 확인하기 전에는 다시
                호출하지 않습니다.
              </p>
              <label>
                확인한 비용 (US$)
                <input name="cost" inputMode="decimal" required />
              </label>
              <label>
                <input type="checkbox" required />
                OpenAI 사용 내역에서 확인했습니다.
              </label>
              <button disabled={busy}>확인한 비용 기록</button>
            </form>
          )}
          {detail?.result?.provenance && (
            <details>
              <summary>실행 정보</summary>
              <small>
                {detail.result.provenance.model} · US$
                {detail.result.costUsd ?? "확인 필요"}
              </small>
            </details>
          )}
        </div>
      </details>
      <div className="assist-request-actions">
        {canDelete ? (
          <button
            type="button"
            className="icon-button"
            aria-label="도움 요청 기록 삭제"
            title="삭제"
            disabled={busy}
            onClick={() => void act("hide", { id: r.id })}
          >
            <Trash2 size={17} />
          </button>
        ) : ["queued", "claimed"].includes(r.status) ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void act("cancel", { id: r.id })}
          >
            취소
          </button>
        ) : null}
      </div>
    </article>
  );
}
