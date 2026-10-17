"use client";
import { libraryRequest } from "@/client/replica/request";
import { useEffect, useRef, useState } from "react";
import { PcAccess } from "./pc-access";
import type { libraryOperations } from "@/server/library-operations";
type State = Awaited<ReturnType<typeof libraryOperations>>;
const stateNames: Record<string, string> = {
  running: "처리 중",
  complete: "이번 수집 완료",
  completed: "이번 작업 완료",
  paused: "일시 중단",
  error: "확인 필요",
  failed: "작업 중단",
  stale: "최근 응답 없음",
  unknown: "실행 정보 없음",
  waiting: "다음 처리 대기",
};
const countNames: Record<string, string> = {
  total: "대상",
  processed: "조사",
  considered: "확인",
  requests: "조회",
  matched: "정보 확인",
  missing: "정보 없음",
  pending: "대기",
  applied: "반영",
  skipped: "기존 결과 유지",
  examined: "확인한 파일",
  withOutline: "목차 있음",
  withoutOutline: "내장 목차 없음",
  unavailable: "연결 확인 필요",
  verified: "판본 확인",
  review: "판본 검토",
  waiting: "문자 인식 대기",
  notFound: "정보 미발견",
  excluded: "기본정보 대상",
  candidates: "목차 후보",
  embedded: "내장 목차 사용",
  noToc: "조사한 쪽에서 목차 미발견",
};
const reasonNames: Record<string, string> = {
  low_disk: "저장 공간이 부족합니다.",
  batch_limit: "이번 실행 범위를 마쳤습니다.",
  requested_stop: "사용자가 중단을 요청했습니다.",
  interrupted: "작업이 중단되었습니다.",
  engine_unavailable: "Windows 문자 인식 환경을 확인해 주세요.",
};
export function LibraryOperationsPanel({
  initiallyOpen = false,
}: {
  initiallyOpen?: boolean;
}) {
  const panel = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (initiallyOpen && panel.current) {
      panel.current.open = true;
      const frame = requestAnimationFrame(() =>
        panel.current?.scrollIntoView({ block: "start" }),
      );
      return () => cancelAnimationFrame(frame);
    }
  }, [initiallyOpen]);
  const [state, setState] = useState<State | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  async function load() {
    setBusy(true);
    setError("");
    try {
      const r = await libraryRequest("/api/library-operations", { cache: "no-store" }),
        j = await r.json();
      if (!r.ok) throw Error(j.error ?? "처리 현황을 읽지 못했습니다.");
      setState(j);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function control(action: "resume" | "pause") {
    setBusy(true);
    setError("");
    try {
      const r = await libraryRequest("/api/library-operations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        }),
        j = await r.json();
      if (!r.ok) throw Error(j.error ?? "작업 요청 실패");
      setMessage(j.message);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details
      ref={panel}
      id="library-operations"
      className="panel"
      onToggle={(e) => {
        if (e.target === e.currentTarget && e.currentTarget.open && !state)
          void load();
      }}
    >
      <summary>자료 준비·오류 확인</summary>
      <p>
        수집 프로그램의 완료와 전체 도서의 정보 확보는 다릅니다. 없는 정보와
        검토가 필요한 자료를 함께 표시합니다.
      </p>
      <button disabled={busy} onClick={() => void load()}>
        처리 현황 새로고침
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {state && !state.localAvailable && (
        <>
          <p>PDF 처리 현황은 PC에서 확인할 수 있습니다.</p>
          <PcAccess operations />
        </>
      )}
      {state?.localAvailable && (
        <>
          <section className="curation-item">
            <h3>PDF 문자 인식</h3>
            <p>{stateNames[state.ocr.status]}</p>
            {state.ocr.reason && (
              <p>
                {reasonNames[state.ocr.reason] ?? "실행 환경을 확인해 주세요."}
              </p>
            )}
            {!state.localAvailable && (
              <p>이 환경에 로컬 색인이 연결되어 있지 않습니다.</p>
            )}
            {state.localAvailable && !state.rootConnected && (
              <p>PDF가 있는 외장하드를 연결해 주세요.</p>
            )}
            <button
              disabled={
                busy || !state.canControl || state.ocr.status === "running"
              }
              onClick={() => void control("resume")}
            >
              남은 문자 인식 재개
            </button>{" "}
            <button
              disabled={
                busy ||
                !state.canControl ||
                !["running", "stale"].includes(state.ocr.status)
              }
              onClick={() => void control("pause")}
            >
              현재 페이지 후 중단
            </button>
          </section>
          {state.collections.map((c) => (
            <section className="curation-item" key={c.label}>
              <h3>
                {c.label} · {stateNames[c.status]}
              </h3>
              {c.updatedAt && (
                <small>
                  최근 갱신 {new Date(c.updatedAt).toLocaleString("ko-KR")}
                </small>
              )}
              <details>
                <summary>처리 건수</summary>
                <p>
                  {Object.entries(c.counts)
                    .map(
                      ([key, value]) =>
                        `${countNames[key] ?? key} ${value.toLocaleString()}건`,
                    )
                    .join(" · ")}
                </p>
              </details>
            </section>
          ))}
          <h3>
            {state.issuesAvailable
              ? `원본 확인이 필요한 자료 ${state.issues.length}건`
              : "원본 상태를 확인할 수 없습니다."}
          </h3>
          {state.issues.map((i) => (
            <article className="curation-item" key={i.id}>
              <strong>{i.title}</strong>
              <p>
                {i.review
                  ? "논문·간행물 여부 확인 전 · 기본정보만 보관"
                  : i.status === "error"
                    ? "PDF 파일을 읽지 못했습니다. 정상 원본을 확보한 뒤 다시 색인해야 합니다."
                    : i.status === "locked"
                      ? "PDF 암호 확인 필요"
                      : i.status === "missing"
                        ? "파일 연결 확인 필요"
                        : "원본 변경 확인 필요"}
              </p>
              <details>
                <summary>확인할 내용</summary>
                <p>
                  원본을 직접 열어 손상·암호 여부를 확인하세요. 파일명과
                  확장자가 PDF여도 실제 내용이 다를 수 있습니다. 이 화면은
                  파일을 삭제하거나 바꾸지 않습니다.
                </p>
              </details>
            </article>
          ))}
        </>
      )}
    </details>
  );
}
