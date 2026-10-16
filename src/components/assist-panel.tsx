"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Library } from "@/lib/domain";
import { DeviceSettings } from "./thought-map/device-settings";
import { AssistHelp } from "./assist-help";
const purposes = {
  organize_note: "AI 정리 · 태그와 주제",
  tag_suggestion: "태그 제안",
  excerpt_explanation: "선택 구절 설명",
  compare_notes: "두 기록 비교 도움",
};
const statusNames: Record<string, string> = {
  queued: "PC 처리 대기",
  claimed: "실행 준비 중",
  sending: "선택한 자료 처리 중",
  completed: "검토할 제안",
  failed: "확인이 필요한 요청",
  cancelled: "취소됨",
  stale: "원문 또는 설정 변경으로 채택 불가",
  cost_unknown: "호출·비용 확인 필요 · 자동 재전송 안 함",
};
export function AssistLauncher(props: {
  library: Library;
  noteId?: string;
  onAdopt?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="assist-launcher"
      onToggle={(e) => {
        if (e.target === e.currentTarget) setOpen(e.currentTarget.open);
      }}
    >
      <summary>필요할 때 AI 도움</summary>
      {open && <AssistPanel {...props} />}
    </details>
  );
}
export function AssistPanel({
  library,
  noteId,
  onAdopt,
}: {
  library: Library;
  noteId?: string;
  onAdopt?: () => void;
}) {
  const [state, setState] = useState<any>(null),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [purpose, setPurpose] = useState<keyof typeof purposes>("organize_note"),
    [first, setFirst] = useState(noteId ?? ""),
    [second, setSecond] = useState(""),
    [excerpt, setExcerpt] = useState(""),
    [preview, setPreview] = useState<any>(null);
  const requestId = useRef("");
  const load = useCallback(async () => {
    const r = await fetch("/api/assist", { cache: "no-store" }),
      j = await r.json();
    if (!r.ok) throw Error(j.error ?? "도움 설정을 불러오지 못했습니다.");
    setState(j);
  }, []);
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [load]);
  const active = state?.requests.some((r: any) =>
    ["queued", "claimed", "sending"].includes(r.status),
  );
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      void load().catch((e) => setError(e.message));
    }, 5000);
    return () => clearInterval(timer);
  }, [active, load]);
  useEffect(() => {
    setPreview(null);
  }, [first, second, purpose, excerpt]);
  async function act(action: string, payload: unknown) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const r = await fetch("/api/assist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, payload }),
        }),
        j = await r.json();
      if (!r.ok) throw Error(j.error ?? "요청하지 못했습니다.");
      if (action === "preview") {
        setPreview(j);
        requestId.current = crypto.randomUUID();
      } else {
        await load();
        if (action === "request") {
          setPreview(null);
          setMessage("선택한 요청을 저장했습니다. PC가 연결되면 처리합니다.");
        } else if (action === "adopt") {
          setMessage("확인한 제안을 보관했습니다. 내 원문은 그대로입니다.");
          onAdopt?.();
        } else setMessage("저장했습니다.");
      }
      return j;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function selection() {
    const n = library.notes.find((n) => n.id === first);
    if (!n) throw Error("저장한 기록을 선택해 주세요.");
    const sources: any[] = [
      { source: { kind: "note", id: n.id, version: String(n.version) } },
    ];
    if (purpose === "excerpt_explanation") {
      const start = n.content.indexOf(excerpt);
      if (!excerpt.trim() || start < 0)
        throw Error("저장된 기록에 있는 구절을 그대로 선택해 주세요.");
      sources[0].selection = { start, end: start + excerpt.length };
    }
    if (purpose === "compare_notes") {
      const other = library.notes.find((n) => n.id === second);
      if (!other || other.id === first)
        throw Error("다른 기록을 선택해 주세요.");
      sources.push({
        source: { kind: "note", id: other.id, version: String(other.version) },
      });
    }
    return { purpose, sources };
  }
  const online = state?.workers.some(
    (w: any) => w.key_ready && Date.now() - Date.parse(w.last_seen) < 120000,
  );
  return (
    <section className="assist-panel">
      <div className="assist-heading">
        <h3>선택한 기록만 도움받기</h3>
        <AssistHelp />
      </div>
      <p>저장한 글을 선택하고, 필요한 제안만 채택하세요.</p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {state && (
        <>
          <details className="assist-settings">
            <summary>AI 사용·비용·PC 설정</summary>
            <form
              className="thought-form"
              key={state.policy.version}
              onSubmit={(e) => {
                e.preventDefault();
                const d = new FormData(e.currentTarget);
                void act("configure", {
                  expectedPolicyVersion: state.policy.version,
                  requestsEnabled: d.get("enabled") === "on",
                  requestLimitUsd: String(d.get("request") || "") || null,
                  runtimeMonthlyLimitUsd:
                    String(d.get("monthly") || "") || null,
                  developmentLimitUsd: state.policy.developmentLimitUsd,
                });
              }}
            >
              <label>
                <input
                  name="enabled"
                  type="checkbox"
                  defaultChecked={state.policy.requestsEnabled}
                />{" "}
                내가 실행한 요청에만 GPT 사용 허용
              </label>
              <label>
                요청당 상한 (미국 달러)
                <input
                  name="request"
                  inputMode="decimal"
                  placeholder="예: 0.01"
                  defaultValue={state.policy.requestLimitUsd ?? ""}
                />
              </label>
              <label>
                월 상한 (미국 달러)
                <input
                  name="monthly"
                  inputMode="decimal"
                  placeholder="예: 1.00"
                  defaultValue={state.policy.runtimeMonthlyLimitUsd ?? ""}
                />
              </label>
              <button disabled={busy}>AI 설정 저장</button>
            </form>
            <DeviceSettings />
            <details>
              <summary>사용량 보기</summary>
              {state.usage.map((u: any, i: number) => (
                <p key={i}>
                  {u.phase === "runtime" ? "이번 달 사용" : "개발 정비"} · 확인
                  비용 ${u.spent} · 예약 ${u.reserved}
                </p>
              ))}
            </details>
          </details>
          {!state.policy.requestsEnabled && (
            <p className="notice">AI 도움 꺼짐 · 설정에서 켤 수 있습니다.</p>
          )}
          <p className="form-hint">
            {online
              ? "PC가 연결되어 있습니다."
              : "PC 연결 대기 · 요청은 연결 후 처리합니다."}
          </p>
          <form
            className="thought-form"
            onSubmit={(e) => {
              e.preventDefault();
              try {
                void act("preview", selection());
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            <label>
              도움 종류
              <select
                value={purpose}
                onChange={(e) =>
                  setPurpose(e.target.value as keyof typeof purposes)
                }
              >
                {Object.entries(purposes).map(([id, label]) => (
                  <option
                    key={id}
                    value={id}
                    disabled={
                      id === "compare_notes" && !state.comparisonEnabled
                    }
                  >
                    {label}
                    {id === "compare_notes" && !state.comparisonEnabled
                      ? " · 성능 검수 대기"
                      : ""}
                  </option>
                ))}
              </select>
            </label>
            <label>
              도움을 받을 기록
              <select
                required
                value={first}
                onChange={(e) => {
                  setFirst(e.target.value);
                  setExcerpt("");
                }}
              >
                <option value="">기록 선택</option>
                {library.notes.map((n) => (
                  <option value={n.id} key={n.id}>
                    {n.title} · {n.content.slice(0, 32)}
                  </option>
                ))}
              </select>
            </label>
            {purpose === "excerpt_explanation" && (
              <label>
                설명을 요청할 구절
                <textarea
                  required
                  value={excerpt}
                  onChange={(e) => setExcerpt(e.target.value)}
                  maxLength={12000}
                  placeholder="저장한 기록에서 필요한 구절을 그대로 붙여 넣으세요."
                />
              </label>
            )}
            {purpose === "compare_notes" && (
              <label>
                비교할 두 번째 기록
                <select
                  required
                  value={second}
                  onChange={(e) => setSecond(e.target.value)}
                >
                  <option value="">기록 선택</option>
                  {library.notes
                    .filter((n) => n.id !== first)
                    .map((n) => (
                      <option key={n.id} value={n.id}>
                        {n.title}
                      </option>
                    ))}
                </select>
              </label>
            )}
            <button disabled={busy || !first}>전송 내용 미리보기</button>
          </form>
          {preview && (
            <div className="assist-preview">
              <h4>전송할 내용 확인</h4>
              <p>
                아래 내용만 OpenAI API로 전송합니다. 이번 요청의 예상 비용
                상한은 US${preview.estimate.maxCostUsd}입니다.
              </p>
              {preview.task.payload.sources.map((s: any, i: number) => (
                <blockquote key={i}>{s.text}</blockquote>
              ))}
              <button
                className="primary"
                disabled={busy || !state.policy.requestsEnabled}
                onClick={() => {
                  try {
                    void act("request", {
                      ...selection(),
                      requestId: requestId.current,
                      expectedPolicyVersion: preview.policy.version,
                      scopeHash: preview.scopeHash,
                    });
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                이 내용으로 AI 도움 요청
              </button>
            </div>
          )}
          <div className="assist-results">
            <h4>내가 요청한 도움</h4>
            {!state.requests.length && <p>요청한 기록이 없습니다.</p>}
            {state.requests.map((r: any) => (
              <article key={r.id}>
                <h4>
                  {purposes[r.purpose as keyof typeof purposes]} ·{" "}
                  {statusNames[r.status] ?? r.status}
                </h4>
                {r.status === "failed" && (
                  <p>
                    원문·사용 한도·PC 연결을 확인해 주세요. 자동 재호출은 하지
                    않습니다.
                  </p>
                )}
                {["queued", "claimed"].includes(r.status) && (
                  <button
                    disabled={busy}
                    onClick={() => void act("cancel", { id: r.id })}
                  >
                    요청 취소
                  </button>
                )}
                {r.result?.valid && r.status === "completed" && (
                  <>
                    <p className="form-hint">
                      AI가 제안한 내용 · 내 기록과 별도로 보관합니다.
                    </p>
                    {r.purpose === "organize_note" &&
                      !r.result.output.items?.length && (
                        <p>이 기록에서 추가할 태그·주제를 찾지 못했습니다.</p>
                      )}
                    {(r.result.output.items ?? r.result.output.tags)?.map(
                      (t: any, i: number) => (
                        <p key={i}>
                          {t.kind === "topic" ? "주제 · " : "태그 · "}
                          {t.value ?? t.tag}{" "}
                          <button
                            disabled={
                              busy ||
                              r.adoption?.some((a: any) => a.index === i)
                            }
                            onClick={() =>
                              void act("adopt", { id: r.id, index: i })
                            }
                          >
                            {r.adoption?.some((a: any) => a.index === i)
                              ? "채택함"
                              : t.kind === "topic"
                                ? "검색 주제로 채택"
                                : "검색 태그로 채택"}
                          </button>
                        </p>
                      ),
                    )}
                    {r.result.output.explanation && (
                      <p>{r.result.output.explanation}</p>
                    )}
                    {r.purpose === "compare_notes" && (
                      <button
                        disabled={busy || r.adoption?.length > 0}
                        onClick={() =>
                          void act("adopt", { id: r.id, index: 0 })
                        }
                      >
                        변화 후보로 보내서 검토
                      </button>
                    )}
                    <details>
                      <summary>근거 보기</summary>
                      <pre>
                        {JSON.stringify(
                          {
                            evidence: r.result.output.evidence ??
                              (
                                r.result.output.items ?? r.result.output.tags
                              )?.map((t: any) => t.evidence) ?? {
                                before: r.result.output.before,
                                after: r.result.output.after,
                              },
                            model: r.result.provenance.model,
                            costUsd: r.result.costUsd,
                          },
                          null,
                          2,
                        )}
                      </pre>
                    </details>
                  </>
                )}
                {r.status === "cost_unknown" && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const d = new FormData(e.currentTarget);
                      void act("resolveCost", {
                        id: r.id,
                        costUsd: String(d.get("cost")),
                      });
                    }}
                  >
                    <p>
                      OpenAI 사용 내역에서 비용을 확인하면 다음 요청을 진행할 수
                      있습니다. 다시 요청하면 추가 비용이 들 수 있습니다.
                    </p>
                    <label>
                      확인한 비용 (미국 달러)
                      <input name="cost" required inputMode="decimal" />
                    </label>
                    <label>
                      <input type="checkbox" required /> API 사용 내역에서
                      확인했습니다.
                    </label>
                    <button disabled={busy}>확인한 비용 기록</button>
                  </form>
                )}
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
