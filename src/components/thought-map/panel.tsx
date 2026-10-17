"use client";
import { libraryRequest } from "@/client/replica/request";
import { useEffect, useRef, useState, useCallback } from "react";
import type { Library } from "@/lib/domain";
import type { ThoughtMapSnapshot } from "@/lib/thought-map/types";
import { TopicBrowser } from "./topic-browser";
import { ThoughtTimeline } from "./timeline";
import { CandidateReview } from "./candidate-review";
import { AssistLauncher } from "../assist-panel";
export function ThoughtMapPanel({
  view,
  library,
  onOpen,
}: {
  view: string;
  library: Library;
  onOpen: (kind: string, id: string) => void;
}) {
  const [state, setState] = useState<ThoughtMapSnapshot | null>(null),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const requests = useRef(new Map<string, string>());
  async function load() {
    const r = await libraryRequest("/api/thought-map", { cache: "no-store" }),
      data = await r.json();
    if (!r.ok) throw Error(data.error ?? "사유의 지도를 불러오지 못했습니다.");
    setState(data);
  }
  useEffect(() => {
    let live = true;
    void libraryRequest("/api/thought-map", { cache: "no-store" })
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw Error(data.error ?? "자료를 불러오지 못했습니다.");
        if (live) setState(data);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [library.notes]);
  async function send(type: string, payload: unknown) {
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    const key = JSON.stringify({ type, payload }),
      requestId = requests.current.get(key) ?? crypto.randomUUID();
    requests.current.set(key, requestId);
    try {
      const r = await libraryRequest("/api/thought-map", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requestId, type, payload }),
        }),
        data = await r.json();
      if (!r.ok) {
        if (r.status < 500) requests.current.delete(key);
        throw Error(data.error ?? "저장하지 못했습니다.");
      }
      requests.current.delete(key);
      await load();
      setMessage("판단과 수정 이력을 저장했습니다.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const completed = useCallback(() => {
    void load().catch((e) => setError(e.message));
  }, []);
  return (
    <section className="thought-panel">
      <div className="thought-actions">
        <button
          disabled={busy}
          onClick={() => void load().catch((e) => setError(e.message))}
        >
          지도 새로고침
        </button>
        <span className="form-hint">
          내 기록을 주제로 묶고, 생각이 달라진 이유를 직접 연결합니다.
        </span>
      </div>
      <AssistLauncher library={library} onAdopt={completed} />
      {error && (
        <p className="error" role="alert">
          {error} 입력 중인 내용은 유지됩니다.
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {!state && !error && (
        <p role="status">사유의 지도를 불러오는 중입니다…</p>
      )}
      {state &&
        (view === "topics" ? (
          <TopicBrowser
            library={library}
            state={state}
            send={send}
            busy={busy}
            onOpen={onOpen}
          />
        ) : view === "timeline" ? (
          <ThoughtTimeline
            library={library}
            state={state}
            send={send}
            busy={busy}
            onOpen={onOpen}
          />
        ) : (
          <CandidateReview
            candidates={state.candidates}
            feedback={state.feedback}
            send={send}
            busy={busy}
            onOpen={onOpen}
          />
        ))}
    </section>
  );
}
