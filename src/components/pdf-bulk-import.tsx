"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useReplicaOptional } from "./replica/provider";
import type { ImportItem, ImportJob } from "@/local/pdf-import/jobs";
import {
  pdfImportRequest,
  PdfImportRequestError,
} from "@/client/pdf-import-request";
type Status = {
  job: ImportJob | null;
  counts?: Record<string, number>;
  total?: number;
  issueCount?: number;
  issues?: ImportItem[];
  history?: { id: string; state: string; updatedAt: number }[];
};
const names: Record<string, string> = {
  scanning: "폴더 조사 중",
  preview: "조사 완료",
  registering: "기본 목록 등록 중",
  enriching: "ISBN·서지 보완 중",
  indexing: "본문 색인 중",
  paused: "일시 중지",
  complete: "등록 작업 완료",
  failed: "확인 후 재개 필요",
};
export function PdfBulkImport({
  root,
  disabled,
  connection,
  onImported,
}: {
  root: string;
  disabled: boolean;
  connection: ReactNode;
  onImported?: () => Promise<void>;
}) {
  const [status, setStatus] = useState<Status>({ job: null }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [connectionNotice, setConnectionNotice] = useState(""),
    [page, setPage] = useState(1),
    [selected, setSelected] = useState("");
  const [action, setAction] = useState("");
  const pendingScan = useRef<{ root: string; id: string } | null>(null);
  const replica = useReplicaOptional(),
    lastSynced = useRef(""),
    lastSyncTime = useRef(0);
  const job = status.job,
    counts = status.counts ?? {},
    running =
      !!job &&
      ["scanning", "registering", "enriching", "indexing"].includes(job.state);
  useEffect(() => {
    let closed = false;
    let loading = false;
    const controller = new AbortController();
    async function load() {
      if (loading) return;
      loading = true;
      try {
        const j = await pdfImportRequest<Status>(
          `/api/pdf/import?page=${page}${selected ? `&id=${encodeURIComponent(selected)}` : ""}`,
          {
            cache: "no-store",
            signal: controller.signal,
          },
        );
        if (!closed) {
          setStatus(j);
          setError("");
          setConnectionNotice("");
        }
      } catch (e) {
        if (
          !closed &&
          !(e instanceof DOMException && e.name === "AbortError")
        ) {
          if (running && e instanceof PdfImportRequestError && e.retryable) {
            setConnectionNotice("진행 상태를 다시 확인하고 있습니다.");
            setError("");
          } else {
            setConnectionNotice("");
            setError((e as Error).message);
          }
        }
      } finally {
        loading = false;
      }
    }
    void load();
    const timer = setInterval(() => {
      if (running) void load();
    }, 2500);
    return () => {
      closed = true;
      controller.abort();
      clearInterval(timer);
    };
  }, [job?.id, job?.state, page, running, selected]);
  useEffect(() => {
    const key = `${job?.id}:${counts.registered ?? 0}:${counts.enriched ?? 0}:${job?.state}`;
    if (
      !counts.registered ||
      key === lastSynced.current ||
      (running && Date.now() - lastSyncTime.current < 15000)
    )
      return;
    lastSynced.current = key;
    lastSyncTime.current = Date.now();
    void (async () => {
      try {
        await replica?.runtime.sync({ reason: "server-save" });
        await onImported?.();
      } catch {
        /* Existing sync status displays retries; registration continues independently. */
      }
    })();
  }, [
    job?.id,
    job?.state,
    counts.registered,
    counts.enriched,
    replica?.runtime,
    onImported,
    running,
  ]);
  async function command(action: string, extra: Record<string, unknown> = {}) {
    setBusy(true);
    setAction(action);
    setError("");
    setConnectionNotice("");
    const requestId =
      action === "scan"
        ? pendingScan.current?.root === root
          ? pendingScan.current.id
          : crypto.randomUUID()
        : undefined;
    if (requestId) pendingScan.current = { root, id: requestId };
    try {
      const j = await pdfImportRequest<Status>("/api/pdf/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, id: job?.id, requestId, ...extra }),
      });
      setStatus(j);
      if (action === "scan") {
        setSelected("");
        pendingScan.current = null;
      }
      setPage(1);
    } catch (e) {
      let recovered = false;
      const recoveryId =
        requestId ??
        (job &&
        e instanceof PdfImportRequestError &&
        e.retryable &&
        ["start", "resume", "retry", "pause", "discard"].includes(action)
          ? job.id
          : undefined);
      if (recoveryId) {
        try {
          const j = await pdfImportRequest<Status>(
            `/api/pdf/import?id=${encodeURIComponent(recoveryId)}`,
            {},
            10000,
          );
          const acknowledged =
            !!requestId ||
            (!!j.job &&
              !!job &&
              (action === "pause"
                ? j.job.pauseRequested && !job.pauseRequested
                : j.job.updatedAt > job.updatedAt &&
                  (action !== "discard" || j.job.state === "complete")));
          if (j.job?.id === recoveryId && acknowledged) {
            setStatus(j);
            setSelected(recoveryId);
            setPage(1);
            pendingScan.current = null;
            recovered = true;
          }
        } catch {
          /* A lost response must not duplicate work or assume a command succeeded. */
        }
      }
      if (!recovered) setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="button-row pdf-import-actions">
        {connection}
        <button
          type="button"
          className="primary"
          disabled={
            disabled ||
            busy ||
            (!!job && job.state !== "complete") ||
            status.history?.some((j) => j.state !== "complete")
          }
          onClick={() => void command("scan", { root })}
        >
          {busy && action === "scan" ? "폴더 조사 요청 중…" : "PDF 일괄 등록"}
        </button>
      </div>
      {error && (
        <div>
          <p role="alert" className="error">
            {error}
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                setStatus(await pdfImportRequest<Status>("/api/pdf/import"));
                setError("");
                setConnectionNotice("");
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            진행 현황 새로고침
          </button>
        </div>
      )}
      {busy && action === "scan" && !job && (
        <p role="status">폴더 조사를 요청하고 있습니다…</p>
      )}
      {connectionNotice && (
        <p role="status" className="pdf-import-connection">
          {connectionNotice}
        </p>
      )}
      {job && (
        <section className="pdf-import-status" aria-label="PDF 일괄 등록 현황">
          {(status.history?.length ?? 0) > 1 && (
            <label>
              등록 작업
              <select
                value={job.id}
                onChange={(e) => {
                  setSelected(e.target.value);
                  setPage(1);
                }}
              >
                {status.history!.map((j, i) => (
                  <option key={j.id} value={j.id}>
                    {new Date(j.updatedAt).toLocaleString("ko-KR")} ·{" "}
                    {names[j.state]}
                    {i === 0 ? " (최근)" : ""}
                  </option>
                ))}
              </select>
            </label>
          )}
          <strong role="status">{names[job.state]}</strong>
          <p>
            조사 {status.total ?? 0}개 · 신규 후보 {counts.new ?? 0}개 · 기존{" "}
            {counts.existing ?? 0}개 · 중복 {counts.duplicate ?? 0}개 · 제외{" "}
            {counts.excluded ?? 0}개 · 보류{" "}
            {(counts.changed ?? 0) + (counts.review ?? 0)}개
          </p>
          {job.state !== "preview" && job.state !== "scanning" && (
            <p>
              기본 등록 {counts.registered ?? 0}개 · 서지 보완 확인{" "}
              {counts.enriched ?? 0}개 · 본문 색인 {counts.indexed ?? 0}개
              {counts.ocrPending
                ? ` · 문자 인식 대기 ${counts.ocrPending}개`
                : ""}
              {counts.errors ? ` · 오류 ${counts.errors}개` : ""}
            </p>
          )}
          {job.error && <p className="error">{job.error}</p>}
          <div className="button-row">
            {job.state === "preview" && (
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => void command("start")}
              >
                등록 시작
              </button>
            )}
            {running && (
              <button
                type="button"
                className="secondary"
                disabled={busy || job.pauseRequested}
                onClick={() => void command("pause")}
              >
                {job.pauseRequested ? "현재 파일 처리 후 중지" : "일시 중지"}
              </button>
            )}
            {(["paused", "failed"].includes(job.state) ||
              (running && Date.now() - job.updatedAt > 120000)) && (
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => void command("resume")}
              >
                이어서 진행
              </button>
            )}
            {job.state === "complete" && !!counts.errors && (
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => void command("retry")}
              >
                오류 재시도
              </button>
            )}
            {["preview", "paused", "failed"].includes(job.state) && (
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
          {!!status.issueCount && (
            <details>
              <summary>검토·오류 {status.issueCount}개</summary>
              {status.issues?.map((item) => (
                <article key={item.document.id} className="pdf-import-issue">
                  <strong>{item.document.title}</strong>
                  <p>{item.error || item.reason}</p>
                  {!item.reviewed && item.records?.length && (
                    <>
                      <p>원본과 같은 판본인지 확인해 선택하세요.</p>
                      {item.records.map((r, index) => (
                        <div key={`${r.provider}:${r.isbn}:${index}`}>
                          <p>
                            {r.facts.title} · {r.facts.author} ·{" "}
                            {r.facts.publisher} · {r.isbn}
                          </p>
                          <button
                            type="button"
                            className="secondary"
                            disabled={busy || running}
                            onClick={() =>
                              void command("apply", {
                                item: item.document.id,
                                index,
                              })
                            }
                          >
                            이 판본으로 반영
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy || running}
                        onClick={() =>
                          void command("ignore", { item: item.document.id })
                        }
                      >
                        후보 제외
                      </button>
                    </>
                  )}
                </article>
              ))}
              {(status.issueCount ?? 0) > 15 && (
                <div className="button-row">
                  <button
                    type="button"
                    className="secondary"
                    disabled={page === 1}
                    onClick={() => setPage((p) => p - 1)}
                  >
                    이전
                  </button>
                  <span>
                    {page} / {Math.ceil(status.issueCount! / 15)}
                  </span>
                  <button
                    type="button"
                    className="secondary"
                    disabled={page * 15 >= status.issueCount!}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    다음
                  </button>
                </div>
              )}
            </details>
          )}
        </section>
      )}
      <details className="pdf-import-help">
        <summary>일괄 등록 사용법</summary>
        <p>
          폴더 조사 → 등록 시작. 처음에는 전체를, 다음에는 추가된 PDF를
          등록합니다. 원본 파일은 그대로 둡니다.
        </p>
        <p>
          창을 닫아도 PC가 켜져 있으면 진행합니다. PC 재시작 후에는 이어서
          진행을 누르세요. 서지 인증키가 없어도 기본 목록과 문자형 PDF 색인은
          가능합니다. 스캔 본문은 문자 인식 후 검색할 수 있습니다.
        </p>
      </details>
    </>
  );
}
