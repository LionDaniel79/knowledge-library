"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { libraryRequest } from "@/client/replica/request";
import type { Library, Note } from "@/lib/domain";
import type { TopicMaterial } from "@/lib/topic-materials";
import {
  assistModels,
  assistModelSchema,
  type AssistModel,
} from "@/lib/assist-synthesis";
import { analysisExcerpt, representativeNotes } from "@/lib/assist-selection";
import { useReplicaOptional } from "./replica/provider";
import { AssistHelp } from "./assist-help";
import { AssistRequestCard } from "./assist-request-card";
export type AssistProps = {
  library: Library;
  noteId?: string;
  onAdopt?: () => void;
  onOpen?: (kind: string, id: string) => void;
  scope?: Record<string, string | number>;
  ownerId?: string;
};
export const focusNames = {
  all: "종합 검토",
  note_connection: "메모끼리의 연결",
  topic_connection: "주제끼리의 연결",
  new_topic: "새 주제 제안",
  writing_idea: "글감·목차 방향",
};
export function AssistLauncher(props: AssistProps) {
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
  onOpen,
  scope,
  ownerId,
}: AssistProps) {
  const replica = useReplicaOptional(),
    key = `library:assist-model:${ownerId || replica?.runtime?.owner || "default"}`;
  const [state, setState] = useState<any>(null),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [model, setModel] = useState<AssistModel>("gpt-6-luna"),
    [focus, setFocus] = useState<keyof typeof focusNames>("all"),
    [maximum, setMaximum] = useState(24),
    [preview, setPreview] = useState<any>(null);
  const running = useRef(false),
    requestId = useRef(""),
    hidden = useRef(new Set<string>());
  const hiddenKey = key.replace(":assist-model:", ":assist-hidden:");
  useEffect(() => {
    hidden.current = new Set();
    try {
      const v = assistModelSchema.safeParse(localStorage.getItem(key));
      setModel(v.success ? v.data : "gpt-6-luna");
      const values = JSON.parse(localStorage.getItem(hiddenKey) ?? "[]");
      hidden.current = new Set(
        Array.isArray(values)
          ? values.filter((v: unknown) => typeof v === "string").slice(-1000)
          : [],
      );
    } catch {}
  }, [key, hiddenKey]);
  const query = {
    kind: "note",
    category: scope?.category ?? "all",
    topic: scope?.topic ?? "all",
    tag: scope?.tag ?? "all",
    bookId: scope?.bookId ?? "all",
    noteType: scope?.noteType ?? "all",
    q: scope?.q ?? "",
    sort: "newest",
  };
  const context = JSON.stringify([query, model, focus, maximum, noteId]),
    contextRef = useRef(context);
  contextRef.current = context;
  const load = useCallback(async () => {
    const r = await libraryRequest(
      "/api/assist",
      { cache: "no-store" },
      { preferServer: typeof navigator === "undefined" || navigator.onLine },
    );
    const j = await r.json();
    if (!r.ok) throw Error(j.error ?? "도움 요청 목록을 불러오지 못했습니다.");
    setState({
      ...j,
      requests: j.requests.filter((r: any) => !hidden.current.has(r.id)),
    });
  }, []);
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [load, replica?.revision]);
  const active = state?.requests?.some((r: any) =>
    ["queued", "claimed", "sending"].includes(r.status),
  );
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      void load().catch((e) => setError(e.message));
    }, 5000);
    return () => clearInterval(timer);
  }, [active, load]);
  async function act(action: string, payload: any) {
    if (running.current) return null;
    running.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const r = await libraryRequest("/api/assist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, payload }),
        }),
        j = await r.json();
      if (!r.ok) throw Error(j.error ?? "요청을 처리하지 못했습니다.");
      if (action === "hide") {
        hidden.current.add(payload.id);
        try {
          localStorage.setItem(
            hiddenKey,
            JSON.stringify([...hidden.current].slice(-1000)),
          );
        } catch {}
        setState((old: any) => ({
          ...old,
          requests: old.requests.filter((r: any) => r.id !== payload.id),
        }));
      }
      if (action === "adopt") {
        setMessage("확인한 제안을 저장했습니다.");
        onAdopt?.();
      }
      if (action !== "preview") void load().catch((e) => setError(e.message));
      return j;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  async function prepare() {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    const ticket = context;
    try {
      if (typeof navigator !== "undefined" && !navigator.onLine)
        throw Error("AI 분석에는 인터넷 연결이 필요합니다.");
      const candidates: TopicMaterial[] = [];
      let total = 0;
      for (let offset = 0; offset < 200; offset += 50) {
        const params = new URLSearchParams(
            Object.entries({ ...query, offset, limit: 50 }).map(([k, v]) => [
              k,
              String(v),
            ]),
          ),
          r = await libraryRequest("/api/library-materials?" + params, {
            cache: "no-store",
          }),
          j = await r.json();
        if (!r.ok) throw Error(j.error ?? "분석할 기록을 찾지 못했습니다.");
        total = j.total;
        candidates.push(...j.items);
        if (candidates.length >= total || !j.items.length) break;
      }
      if (noteId && !scope && !candidates.some((n) => n.id === noteId)) {
        const r = await libraryRequest("/api/notes/" + noteId, {
            cache: "no-store",
          }),
          n = await r.json();
        if (!r.ok) throw Error(n.error);
        candidates.unshift({
          id: n.id,
          kind: "note",
          title: n.title,
          text: n.content,
          category: "",
          version: n.version,
          bookId: n.bookId,
          bookTitle: "",
          topicIds: [],
          topicNames: [],
          createdAt: n.createdAt,
          updatedAt: n.updatedAt,
        });
      }
      const chosen = representativeNotes(candidates, maximum, noteId);
      if (chosen.length < 2)
        throw Error(
          "함께 검토할 기록이 두 개 이상 필요합니다. 필터를 넓혀 주세요.",
        );
      const full: Note[] = [];
      for (let i = 0; i < chosen.length; i += 4)
        full.push(
          ...(await Promise.all(
            chosen.slice(i, i + 4).map(async (c) => {
              const local = library.notes.find(
                (n) => n.id === c.id && !n.summary && n.version === c.version,
              );
              if (local) return local;
              const r = await libraryRequest("/api/notes/" + c.id, {
                  cache: "no-store",
                }),
                n = await r.json();
              if (!r.ok) throw Error(n.error);
              if (n.version !== c.version)
                throw Error("기록이 변경됐습니다. 다시 확인해 주세요.");
              return n;
            }),
          )),
        );
      const budget = Math.min(1200, Math.floor(10000 / full.length)),
        sources = full.map((n) => {
          const selection = analysisExcerpt(n.content, String(query.q), budget);
          return {
            source: { kind: "note", id: n.id, version: String(n.version) },
            ...(selection ? { selection } : {}),
          };
        });
      const selection = { purpose: "synthesis", model, focus, sources },
        r = await libraryRequest("/api/assist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "preview", payload: selection }),
        }),
        j = await r.json();
      if (!r.ok) throw Error(j.error ?? "전송 내용을 확인하지 못했습니다.");
      if (contextRef.current !== ticket) return;
      requestId.current = crypto.randomUUID();
      setPreview({
        ...j,
        selection,
        titles: full.map((n) => n.title || n.content.slice(0, 50)),
        total,
        candidateCount: candidates.length,
        context: ticket,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  const currentPreview = preview?.context === context ? preview : null;
  const exceeds =
    currentPreview &&
    Number(currentPreview.estimate.maxCostUsd) >
      Number(currentPreview.policy.requestLimitUsd ?? 0);
  const allowance = currentPreview
    ? (
        Math.ceil(Number(currentPreview.estimate.maxCostUsd) * 1000000) /
        1000000
      ).toFixed(6)
    : "0";
  return (
    <section className="assist-panel assist-synthesis">
      <div className="assist-heading">
        <h3>생각을 넓히는 AI 도움</h3>
        <AssistHelp />
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <div className="assist-synthesis-controls">
        <label>
          도움 방향
          <select
            aria-label="도움 방향"
            value={focus}
            onChange={(e) =>
              setFocus(e.target.value as keyof typeof focusNames)
            }
          >
            {Object.entries(focusNames).map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <button disabled={busy} onClick={() => void prepare()}>
          {busy ? "처리 중…" : "분석할 기록 확인"}
        </button>
        <details className="assist-model-choice">
          <summary>모델 선택</summary>
          <label>
            AI 모델
            <select
              aria-label="AI 모델"
              value={model}
              onChange={(e) => {
                const v = assistModelSchema.parse(e.target.value);
                setModel(v);
                try {
                  localStorage.setItem(key, v);
                } catch {}
              }}
            >
              {Object.entries(assistModels).map(([id, m]) => (
                <option key={id} value={id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            대표 기록 수
            <select
              value={maximum}
              onChange={(e) => setMaximum(Number(e.target.value))}
            >
              <option value={24}>최대 24개</option>
              <option value={12}>최대 12개</option>
              <option value={6}>최대 6개</option>
            </select>
          </label>
        </details>
      </div>
      <small>
        현재 선택한 조건의 기록을 바탕으로 검토합니다. 확인한 제안만 저장합니다.
      </small>
      {currentPreview && (
        <section className="assist-preview">
          <strong>
            조건에 맞는 {currentPreview.total}개 중{" "}
            {currentPreview.task.payload.sources.length}개 검토
          </strong>
          <small>예상 비용 상한 US${currentPreview.estimate.maxCostUsd}</small>
          <details>
            <summary>전송할 기록 확인</summary>
            {currentPreview.task.payload.sources.map((s: any, i: number) => (
              <div key={s.source.id}>
                <strong>{currentPreview.titles[i]}</strong>
                <small>{s.coverage === "partial" ? "발췌" : "전체 기록"}</small>
                <blockquote>{s.text}</blockquote>
              </div>
            ))}
            {currentPreview.total > 200 && (
              <p>
                최대 200개 후보에서 대표 기록을 골랐습니다. 범위를 좁히면 다른
                기록도 검토할 수 있습니다.
              </p>
            )}
          </details>
          {exceeds && (
            <div className="notice">
              <p>
                기존 건당 한도를 넘습니다. 모델이나 기록 수를 줄이거나 아래
                한도를 직접 확인해 주세요.
              </p>
              <button
                disabled={
                  busy ||
                  active ||
                  !currentPreview.policy.requestsEnabled ||
                  Number(currentPreview.estimate.maxCostUsd) >
                    Math.min(
                      1,
                      Number(currentPreview.policy.runtimeMonthlyLimitUsd ?? 0),
                    )
                }
                onClick={async () => {
                  if (
                    await act("allowRequest", {
                      expectedPolicyVersion: currentPreview.policy.version,
                      maxCostUsd: allowance,
                    })
                  ) {
                    setPreview(null);
                    await prepare();
                  }
                }}
              >
                건당 한도를 US${allowance}로 조정 · 월 한도 유지
              </button>
            </div>
          )}
          {!currentPreview.policy.requestsEnabled && (
            <p role="alert">현재 AI 요청이 꺼져 있습니다.</p>
          )}
          <button
            className="primary"
            disabled={busy || exceeds || !currentPreview.policy.requestsEnabled}
            onClick={async () => {
              const j = await act("request", {
                ...currentPreview.selection,
                requestId: requestId.current,
                expectedPolicyVersion: currentPreview.policy.version,
                scopeHash: currentPreview.scopeHash,
              });
              if (j) {
                setPreview(null);
                setMessage(
                  "요청을 저장했습니다. 결과가 준비되면 아래에 표시합니다.",
                );
              }
            }}
          >
            이 기록으로 AI 도움 요청
          </button>
        </section>
      )}
      <div className="assist-results">
        <div className="section-heading">
          <h4>내가 요청한 도움</h4>
          <button
            className="text-button"
            aria-label="요청 목록 새로고침"
            onClick={() => void load().catch((e) => setError(e.message))}
          >
            새로고침
          </button>
        </div>
        {!state && <p role="status">요청 목록을 불러오는 중…</p>}
        {state && !state.requests?.length && <p>요청한 기록이 없습니다.</p>}
        {state?.requests?.map((r: any) => (
          <AssistRequestCard
            key={r.id}
            request={r}
            busy={busy}
            act={act}
            library={library}
            onOpen={onOpen}
          />
        ))}
      </div>
    </section>
  );
}
