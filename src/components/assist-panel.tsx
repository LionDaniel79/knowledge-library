"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ChevronDown, RefreshCw, Sparkles } from "lucide-react";
import { libraryRequest } from "@/client/replica/request";
import { rememberConfirmedRelationship } from "@/lib/assist-adoption-overlay";
import type { TopicMaterial } from "@/lib/topic-materials";
import type { Library, Note } from "@/lib/domain";
import {
  assistModels,
  assistModelSchema,
  type AssistModel,
  type WritingContext,
  type SynthesisResult,
  type EditorContext,
} from "@/lib/assist-synthesis";
import {
  analysisExcerpt,
  representativeNotes,
  collectAnalysisNotes,
} from "@/lib/assist-selection";
import { useReplicaOptional } from "./replica/provider";
import { AssistHelp } from "./assist-help";
import { AssistRequestCard } from "./assist-request-card";
export type AssistProps = {
  library: Library;
  allowedFocus?: (keyof typeof focusNames)[];
  noteId?: string;
  editorAnalysis?: {
    context: EditorContext;
    notes: Note[];
    onApply: (
      suggestion: SynthesisResult["suggestions"][number],
    ) => void | Promise<void>;
  };
  onAdopt?: (result: any) => void;
  onOpen?: (kind: string, id: string) => void;
  scope?: Record<string, string | number>;
  ownerId?: string;
  analysis?: { notes: Note[]; context: WritingContext };
  onWritingSuggestion?: (
    suggestion: SynthesisResult["suggestions"][number],
    scope: any,
  ) => boolean | void | Promise<boolean | void>;
  analysisControls?: (onAnalyze: () => void, busy: boolean) => ReactNode;
};
export const focusNames = {
  all: "종합검토",
  note_connection: "메모 연결 제안",
  editor_title: "제목 추천",
  connection_title: "연결메모 제목 제안",
  thought_bundle: "생각묶음 제안",
  thought_bundle_title: "생각묶음 제목 제안",
};
export function AssistLauncher({
  children,
  enabled = true,
  ...props
}: AssistProps & { children?: ReactNode; enabled?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="assist-entry">
      <details
        className="assist-launcher"
        onToggle={(e) => {
          if (e.target === e.currentTarget) setOpen(e.currentTarget.open);
        }}
      >
        <summary className="assist-launcher-summary">
          <span className="assist-launcher-title">
            <Sparkles size={17} aria-hidden="true" /> AI 도움
          </span>
          <ChevronDown
            className="assist-launcher-chevron"
            size={16}
            aria-hidden="true"
          />
        </summary>
        {open && (
          <div className="assist-launcher-body">
            {children}
            {enabled && <AssistPanel {...props} />}
          </div>
        )}
      </details>
      <div className="assist-launcher-help">
        <AssistHelp />
      </div>
    </div>
  );
}
export function AssistPanel({
  library,
  noteId,
  onAdopt,
  onOpen,
  scope,
  ownerId,
  analysis,
  onWritingSuggestion,
  analysisControls,
  editorAnalysis,
  allowedFocus,
}: AssistProps) {
  const noteFieldsMode = !!editorAnalysis?.context.fields;
  const replica = useReplicaOptional(),
    key = `library:assist-model:${ownerId || replica?.runtime?.owner || "default"}`;
  const [state, setState] = useState<any>(null),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [model, setModel] = useState<AssistModel>("gpt-6-luna"),
    [focus, setFocus] = useState<keyof typeof focusNames>(
      editorAnalysis ? "editor_title" : "all",
    ),
    [maximum, setMaximum] = useState(24),
    [requestsOpen, setRequestsOpen] = useState(false);
  const running = useRef(false),
    hidden = useRef(new Set<string>());
  const hiddenKey = key.replace(":assist-model:", ":assist-hidden:");
  useEffect(() => {
    hidden.current = new Set();
    try {
      const v = assistModelSchema.safeParse(localStorage.getItem(key));
      setModel(!noteFieldsMode && v.success ? v.data : "gpt-6-luna");
      const values = JSON.parse(localStorage.getItem(hiddenKey) ?? "[]");
      hidden.current = new Set(
        Array.isArray(values)
          ? values.filter((v: unknown) => typeof v === "string").slice(-1000)
          : [],
      );
    } catch {}
  }, [key, hiddenKey, noteFieldsMode]);
  const query = {
    ...scope,
    kind: "note",
    category: scope?.category ?? "all",
    topic: scope?.topic ?? "all",
    tag: scope?.tag ?? "all",
    bookId: scope?.bookId ?? "all",
    noteType: scope?.noteType ?? "all",
    q: scope?.q ?? "",
    sort: "newest",
  };
  const context = JSON.stringify([
      query,
      model,
      focus,
      maximum,
      noteId,
      analysis?.context,
      editorAnalysis?.context,
      analysis?.notes.map((n) => [n.id, n.version]),
    ]),
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
  }, [load]);
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
  async function postAssist(action: string, payload: unknown) {
    const response = await libraryRequest(
      "/api/assist",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, payload }),
      },
      { preferServer: true, skipDeviceSync: action === "preview" },
    );
    const result = await response.json();
    if (!response.ok)
      throw Error(result.error ?? "요청을 처리하지 못했습니다.");
    return result;
  }
  async function act(action: string, payload: any) {
    if (running.current) return null;
    running.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const j = await postAssist(action, payload);
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
        if (!j.ok || !j.adoption?.id)
          throw Error("연결 확정 결과를 확인하지 못했습니다.");
        setState((old: any) =>
          old
            ? {
                ...old,
                requests: old.requests.map((request: any) =>
                  request.id === payload.id
                    ? {
                        ...request,
                        adoption: [
                          ...(request.adoption ?? []).filter(
                            (a: any) => a.index !== j.adoption.index,
                          ),
                          j.adoption,
                        ],
                      }
                    : request,
                ),
              }
            : old,
        );
        setMessage(
          j.connection
            ? "선택한 메모 연결을 확정했습니다. 연결된 메모 목록에 반영됩니다."
            : j.bundle
              ? "선택한 생각묶음을 저장했습니다."
              : "선택한 제안을 저장했습니다.",
        );
        rememberConfirmedRelationship(
          ownerId || replica?.runtime?.owner || "",
          {
            connection: j.connection,
            bundle: j.bundle,
          },
        );
        if (typeof window !== "undefined")
          window.dispatchEvent(
            new CustomEvent("library:assist-adopted", {
              detail: {
                ownerId: ownerId || replica?.runtime?.owner || "",
                connection: j.connection,
                bundle: j.bundle,
              },
            }),
          );
        onAdopt?.(j);
      }
      if (action !== "adopt")
        void load().catch(() => {
          // Refresh failure must not turn a successful persisted adoption
          // into an apparent save error. The confirmed row is already visible.
        });
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
      const fixed = editorAnalysis && focus === "editor_title";
      const selectedNotes = fixed ? editorAnalysis.notes : analysis?.notes;
      const { candidates } = selectedNotes
        ? {
            candidates: selectedNotes.map((n) => ({
              id: n.id,
              kind: "note" as const,
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
            })),
          }
        : await collectAnalysisNotes(async (offset) => {
            const params = new URLSearchParams(
                Object.entries({ ...query, offset, limit: 50 }).map(
                  ([k, v]) => [k, String(v)],
                ),
              ),
              r = await libraryRequest("/api/library-materials?" + params, {
                cache: "no-store",
              }),
              j = await r.json();
            if (!r.ok) throw Error(j.error ?? "분석할 기록을 찾지 못했습니다.");
            return j;
          }, maximum === 0);
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
      if (editorAnalysis && !fixed)
        for (const n of editorAnalysis.notes) {
          if (!candidates.some((c) => c.id === n.id))
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
      const chosen: TopicMaterial[] = fixed
        ? candidates
        : maximum === 0
          ? candidates
          : representativeNotes(candidates, maximum, noteId);
      if (editorAnalysis && !fixed)
        for (const id of editorAnalysis.context.noteIds) {
          const member = candidates.find((c) => c.id === id);
          if (member && !chosen.some((c) => c.id === id)) chosen.push(member);
        }
      if (chosen.length < (fixed ? 1 : 2))
        throw Error(
          "함께 검토할 기록이 두 개 이상 필요합니다. 필터를 넓혀 주세요.",
        );
      const full: Note[] = [];
      for (let i = 0; i < chosen.length; i += 4)
        full.push(
          ...(await Promise.all(
            chosen.slice(i, i + 4).map(async (c) => {
              const local = [
                ...(editorAnalysis?.notes ?? []),
                ...(analysis?.notes ?? []),
                ...library.notes,
              ].find(
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
          const selection =
            maximum === 0
              ? undefined
              : analysisExcerpt(n.content, String(query.q), budget);
          return {
            source: { kind: "note", id: n.id, version: String(n.version) },
            ...(selection ? { selection } : {}),
          };
        });
      const selection = {
        purpose: "synthesis",
        ...(!analysis &&
        (!editorAnalysis || editorAnalysis.context.kind === "note")
          ? { recordsOnly: true }
          : {}),
        model,
        focus: analysis ? "writing_idea" : focus,
        sources,
        ...(editorAnalysis ? { editorContext: editorAnalysis.context } : {}),
        ...(!analysis ? { useCurrentRelations: true } : {}),
        ...(analysis ? { writingContext: analysis.context } : {}),
      };
      // Keep server-side source, version and budget checks as part of one user action.
      const j = await postAssist("preview", selection);
      if (contextRef.current !== ticket) return;
      if (
        !analysis &&
        focus === "connection_title" &&
        !j.task.payload.existingConnections?.length
      )
        throw Error(
          "선택한 기록 사이에 제목을 제안할 기존 메모 연결이 없습니다.",
        );
      if (
        !analysis &&
        focus === "thought_bundle_title" &&
        !j.task.payload.existingBundles?.length
      )
        throw Error("선택한 기록을 함께 포함하는 기존 생각묶음이 없습니다.");
      if (!j.policy.requestsEnabled)
        throw Error("현재 AI 요청이 꺼져 있습니다.");
      await postAssist("request", {
        ...selection,
        requestId: crypto.randomUUID(),
        expectedPolicyVersion: j.policy.version,
        scopeHash: j.scopeHash,
      });
      if (contextRef.current === ticket) {
        setRequestsOpen(true);
        setMessage("요청을 저장했습니다. 결과가 준비되면 아래에 표시합니다.");
      }
      void load().catch(() => {});
    } catch (e) {
      if (contextRef.current === ticket) setError((e as Error).message);
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  const visibleRequests = state?.requests?.filter((r: any) =>
    analysis
      ? r.scope?.writingContext?.boardId === analysis.context.boardId
      : editorAnalysis
        ? r.scope?.editorContext?.id === editorAnalysis.context.id &&
          r.scope?.editorContext?.kind === editorAnalysis.context.kind
        : !r.scope?.writingContext && !r.scope?.editorContext,
  );
  return (
    <section className="assist-panel assist-synthesis">
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {message && (
        <p className="assist-status" role="status">
          {message}
        </p>
      )}
      {analysisControls ? (
        <div className="assist-analysis-controls">
          {analysisControls(() => void prepare(), busy)}
        </div>
      ) : (
        <div className="assist-topline">
          <div className="assist-synthesis-controls">
            {!noteFieldsMode && (
              <label>
                도움 방향
                <select
                  aria-label="도움 방향"
                  value={focus}
                  onChange={(e) =>
                    setFocus(e.target.value as keyof typeof focusNames)
                  }
                >
                  {Object.entries(focusNames)
                    .filter(
                      ([id]) =>
                        !allowedFocus ||
                        allowedFocus.includes(id as keyof typeof focusNames),
                    )
                    .filter(([id]) =>
                      editorAnalysis
                        ? (id === "all" &&
                            editorAnalysis.context.kind === "note") ||
                          id === "editor_title" ||
                          (id === "note_connection" &&
                            editorAnalysis.context.kind !== "bundle")
                        : ["all", "note_connection"].includes(id),
                    )
                    .map(([id, name]) => (
                      <option key={id} value={id}>
                        {id === "editor_title"
                          ? editorAnalysis?.context.kind === "note"
                            ? "메모 제목 추천"
                            : editorAnalysis?.context.kind === "bundle"
                              ? "생각 묶음 제목 추천"
                              : "연결 메모 제목 추천"
                          : editorAnalysis && id === "note_connection"
                            ? "연결 메모 추천"
                            : name}
                      </option>
                    ))}
                </select>
              </label>
            )}
            <button
              className="primary assist-run"
              type="button"
              disabled={
                busy ||
                (noteFieldsMode &&
                  !editorAnalysis?.context.fields?.missing.length)
              }
              onClick={() => void prepare()}
            >
              <Sparkles size={15} aria-hidden="true" />
              {busy ? "처리 중…" : noteFieldsMode ? "빈 항목 추천" : "분석"}
            </button>
          </div>
        </div>
      )}
      {!noteFieldsMode && (
        <div className="assist-model-row">
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
              전송 메모 수
              <select
                value={maximum}
                onChange={(e) => setMaximum(Number(e.target.value))}
              >
                <option value={0}>전체</option>
                <option value={24}>최대 24개</option>
                <option value={12}>최대 12개</option>
                <option value={6}>최대 6개</option>
              </select>
            </label>
          </details>
        </div>
      )}
      <div className="assist-results">
        <details
          className="assist-results-toggle"
          open={requestsOpen}
          onToggle={(event) => setRequestsOpen(event.currentTarget.open)}
        >
          <summary>
            <h4>내가 요청한 도움</h4>
          </summary>
          <div className="assist-results-content">
            <div className="assist-results-actions">
              <button
                className="text-button"
                aria-label="요청 목록 새로고침"
                onClick={() => void load().catch((e) => setError(e.message))}
              >
                <RefreshCw size={14} aria-hidden="true" />
                새로고침
              </button>
            </div>
            {!state && <p role="status">요청 목록을 불러오는 중…</p>}
            {state && !message && !visibleRequests?.length && (
              <p>요청한 기록이 없습니다.</p>
            )}
            {visibleRequests?.map((r: any) => (
              <AssistRequestCard
                key={r.id}
                request={r}
                busy={busy}
                act={act}
                library={library}
                onOpen={onOpen}
                allowedKinds={
                  !analysis
                    ? editorAnalysis?.context.kind === "bundle"
                      ? ["editor_title"]
                      : editorAnalysis
                        ? ["editor_title", "note_connection"]
                        : ["note_connection"]
                    : undefined
                }
                onEditorSuggestion={
                  editorAnalysis
                    ? async (suggestion, savedScope) => {
                        if (
                          savedScope.editorContext?.fields?.kind !==
                            editorAnalysis.context.fields?.kind ||
                          JSON.stringify(savedScope.editorContext?.draft) !==
                            JSON.stringify(editorAnalysis.context.draft) ||
                          savedScope.editorContext?.id !==
                            editorAnalysis.context.id ||
                          savedScope.editorContext?.kind !==
                            editorAnalysis.context.kind ||
                          editorAnalysis.notes.some(
                            (n) =>
                              !savedScope.sources?.some(
                                (v: any) =>
                                  v.id === n.id &&
                                  String(v.version) === String(n.version),
                              ),
                          )
                        )
                          throw Error(
                            "대상 메모가 변경되었습니다. 다시 분석해 주세요.",
                          );
                        await editorAnalysis.onApply(suggestion);
                      }
                    : undefined
                }
                onWritingSuggestion={analysis ? onWritingSuggestion : undefined}
              />
            ))}
          </div>
        </details>
      </div>
    </section>
  );
}
