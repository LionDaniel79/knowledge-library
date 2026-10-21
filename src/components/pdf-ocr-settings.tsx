"use client";
import { useEffect, useState } from "react";
type OcrJob = {
  id: string;
  state: string;
  mode: string;
  scope: string;
  updated: number;
  pause: number;
  error: string;
  sample: number;
};
type OcrPage = {
  document_id: string;
  page_number: number;
  page_id: number;
  title: string;
  old_text: string | null;
  new_text: string | null;
  state: string;
  error: string;
  review: string | null;
};
type Status = {
  job: OcrJob | null;
  counts?: Record<string, number>;
  total?: number;
  pages?: OcrPage[];
  history?: { id: string; state: string; created: number }[];
};
const names: Record<string, string> = {
  queued: "작업 준비 중",
  running: "본문 재인식 중",
  paused: "일시 중지",
  complete: "작업 완료 · 결과 확인",
  failed: "확인 후 재개 필요",
  applying: "검색 색인에 반영 중",
  restoring: "이전 결과로 복원 중",
};
export function PdfOcrSettings() {
  const [open, setOpen] = useState(false),
    [status, setStatus] = useState<Status>({ job: null }),
    [selected, setSelected] = useState(""),
    [page, setPage] = useState(1),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const job = status.job,
    counts = status.counts ?? {},
    active =
      !!job &&
      ["queued", "running", "applying", "restoring"].includes(job.state);
  useEffect(() => {
    if (!open) return;
    let closed = false;
    const controller = new AbortController();
    async function load() {
      try {
        const r = await fetch(
            `/api/pdf/reprocess?page=${page}${selected ? `&id=${selected}` : ""}`,
            { cache: "no-store", signal: controller.signal },
          ),
          j = await r.json();
        if (!r.ok) throw Error(j.error);
        if (!closed) setStatus(j);
      } catch (e) {
        if (!closed && !(e instanceof DOMException && e.name === "AbortError"))
          setError((e as Error).message);
      }
    }
    void load();
    const timer = setInterval(() => {
      if (active) void load();
    }, 4000);
    return () => {
      closed = true;
      controller.abort();
      clearInterval(timer);
    };
  }, [open, page, selected, job?.id, job?.state, active]);
  async function command(action: string, extra: Record<string, unknown> = {}) {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/pdf/reprocess", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, id: job?.id, ...extra }),
        }),
        j = await r.json();
      if (!r.ok) throw Error(j.error);
      if (
        j.job &&
        ["create", "resume", "retry", "apply_all", "restore_all"].includes(
          action,
        )
      )
        j.job.state =
          action === "apply_all"
            ? "applying"
            : action === "restore_all"
              ? "restoring"
              : "running";
      setStatus(j);
      if (action === "create") setSelected("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const canStart =
    !busy &&
    (!job || job.state === "complete") &&
    !status.history?.some((h) => h.state !== "complete");
  return (
    <details
      className="pdf-ocr-settings"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>OCR 품질·다시 인식</summary>
      {open && (
        <>
          <div className="button-row">
            <button
              type="button"
              className="secondary"
              disabled={!canStart}
              onClick={() =>
                void command("create", { sample: true, scope: "all" })
              }
            >
              표본 5쪽 비교
            </button>
            <button
              type="button"
              className="secondary"
              disabled={!canStart}
              onClick={() =>
                void command("create", { sample: false, scope: "all" })
              }
            >
              전체 OCR 다시하기
            </button>
          </div>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {job && (
            <section aria-label="OCR 재인식 현황">
              {(status.history?.length ?? 0) > 1 && (
                <label>
                  OCR 작업
                  <select
                    value={job.id}
                    onChange={(e) => {
                      setSelected(e.target.value);
                      setPage(1);
                    }}
                  >
                    {status.history!.map((h) => (
                      <option key={h.id} value={h.id}>
                        {new Date(h.created * 1000).toLocaleString("ko-KR")} ·{" "}
                        {names[h.state]}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <p role="status">
                <strong>{names[job.state]}</strong>
              </p>
              <p>
                대상 {status.total ?? 0}쪽 · 새 결과 {counts.ready ?? 0}쪽 ·
                확인 필요 {counts.review ?? 0}쪽 · 반영 {counts.applied ?? 0}쪽
                · 오류 {counts.error ?? 0}쪽
                {counts.stale ? ` · 원본·내용 변경 ${counts.stale}쪽` : ""}
              </p>
              {job.error && <p className="error">{job.error}</p>}
              <div className="button-row">
                {active && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy || !!job.pause}
                    onClick={() => void command("pause")}
                  >
                    {job.pause ? "현재 쪽 처리 후 중지" : "일시 중지"}
                  </button>
                )}
                {(["paused", "failed"].includes(job.state) ||
                  (active && Date.now() - job.updated * 1000 > 120000)) && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => void command("resume")}
                  >
                    이어서 진행
                  </button>
                )}
                {!active && !!counts.error && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => void command("retry")}
                  >
                    오류 재시도
                  </button>
                )}
                {!active && !!counts.ready && (
                  <button
                    type="button"
                    className="primary"
                    disabled={busy}
                    onClick={() => void command("apply_all")}
                  >
                    검토 후 전체 반영
                  </button>
                )}
                {!active && !!counts.applied && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => void command("restore_all")}
                  >
                    이전 결과로 복원
                  </button>
                )}
                {!active && job.state !== "complete" && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => void command("discard")}
                  >
                    작업 종료
                  </button>
                )}
              </div>
              {status.pages?.map((p) => (
                <details key={p.page_id} className="ocr-page-comparison">
                  <summary>
                    {p.title} · PDF {p.page_number}쪽
                    {p.state === "review"
                      ? " · 확인 필요"
                      : p.state === "applied"
                        ? " · 반영됨"
                        : ""}
                  </summary>
                  {p.error && <p className="error">{p.error}</p>}
                  {p.review && (
                    <p>
                      {(() => {
                        try {
                          return JSON.parse(p.review).join(" · ");
                        } catch {
                          return "원문과 비교해 주세요.";
                        }
                      })()}
                    </p>
                  )}
                  <div className="ocr-comparison-columns">
                    <div>
                      <strong>기존 결과</strong>
                      <pre>{p.old_text || "기존 본문 없음"}</pre>
                    </div>
                    <div>
                      <strong>새 결과</strong>
                      <pre>{p.new_text || "아직 처리하지 않았습니다."}</pre>
                    </div>
                  </div>
                  {!active &&
                    ["ready", "review"].includes(p.state) &&
                    p.new_text && (
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy}
                        onClick={() =>
                          void command("apply", {
                            pageId: p.page_id,
                            includeReview: true,
                          })
                        }
                      >
                        이 쪽 반영
                      </button>
                    )}
                  {!active && ["ready", "review"].includes(p.state) && (
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() =>
                        void command("exclude", { pageId: p.page_id })
                      }
                    >
                      본문에서 제외
                    </button>
                  )}
                  {!active && p.state === "applied" && (
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() =>
                        void command("restore", { pageId: p.page_id })
                      }
                    >
                      이 쪽 복원
                    </button>
                  )}
                </details>
              ))}
              {(status.total ?? 0) > 10 && (
                <div className="button-row">
                  <button
                    type="button"
                    className="secondary"
                    disabled={page === 1}
                    onClick={() => setPage((n) => n - 1)}
                  >
                    이전
                  </button>
                  <span>
                    {page} / {Math.ceil(status.total! / 10)}
                  </span>
                  <button
                    type="button"
                    className="secondary"
                    disabled={page * 10 >= status.total!}
                    onClick={() => setPage((n) => n + 1)}
                  >
                    다음
                  </button>
                </div>
              )}
            </section>
          )}
          <details>
            <summary>사용법</summary>
            <p>
              먼저 표본을 비교한 뒤 전체를 재인식하세요. 본문·각주를 유지하고,
              반복 여백과 쪽번호를 걸러 새 결과를 보관합니다. 새 결과는 검토 후
              반영하며, ‘확인 필요’ 쪽은 개별 반영합니다. 원본 PDF와 원래 문자형
              본문은 유지합니다.
            </p>
            <p>
              모든 OCR 결과는 PC 색인에 저장됩니다. Neon 한도와 관계없이 PC
              작업은 이어갈 수 있으나 로그인·웹 동기화는 제한될 수 있습니다.
              창을 닫아도 PC가 켜져 있으면 진행합니다.
            </p>
          </details>
        </>
      )}
    </details>
  );
}
