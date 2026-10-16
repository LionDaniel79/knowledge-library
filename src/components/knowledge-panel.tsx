"use client";
import { ResearchBoard } from "./research-board";
import { exportResearchMarkdown, type ResearchPlacement } from "@/lib/research";
import { ThoughtMapPanel } from "./thought-map/panel";
import { ThoughtMapHelp } from "./thought-map/help";
import { useEffect, useMemo, useRef, useState } from "react";
import { useBookCatalog } from "./use-book-catalog";
import type { Library, Revision } from "@/lib/domain";
import { relationNames, type Relation } from "@/lib/knowledge";
type Connection = {
  id: string;
  source_kind: string;
  source_id: string;
  target_kind: string;
  target_id: string;
  relation: Relation;
  status: string;
  reason: string;
  version: number;
};
type Research = { id: string; title: string; kind: string; question: string };
type Item = {
  id: string;
  research_id: string;
  snapshot: {
    note: {
      id?: string;
      title: string;
      content: string;
      page: number | null;
      version: number;
      kind: string;
      sourceData?: {
        app: string;
        recordId: string;
        raw: Record<string, unknown>;
      };
    };
    book: {
      id?: string;
      title: string;
      author: string;
      publisher: string;
      isbn: string;
    } | null;
  };
};
type State = {
  connections: Connection[];
  research: Research[];
  items: Item[];
  placements: ResearchPlacement[];
};
export function KnowledgePanel({
  library,
  onOpen,
}: {
  library: Library;
  onOpen: (kind: string, id: string) => void;
}) {
  const [find, setFind] = useState("");
  const [helpOpen, setHelpOpen] = useState(false);
  const catalog = useBookCatalog({
    enabled: !!library.catalog,
    query: { q: find, sort: "title" },
    revision: library,
  });
  const [chosen, setChosen] = useState<
    { id: string; kind: string; title: string }[]
  >([]);
  const nodes = useMemo(
    () => [
      ...new Map(
        [
          ...library.notes.map((n) => ({
            id: n.id,
            kind: "note",
            title: `${n.title} · ${library.books.find((b) => b.id === n.bookId)?.title ?? n.content.slice(0, 60)}`,
          })),
          ...library.books.map((b) => ({
            id: b.id,
            kind: "book",
            title: b.title,
          })),
          ...chosen,
          ...catalog.items.map((b) => ({
            id: b.id,
            kind: "book",
            title: b.title,
          })),
        ].map((n) => [n.kind + ":" + n.id, n]),
      ).values(),
    ],
    [library, catalog.items, chosen],
  );
  const [state, setState] = useState<State>({
      connections: [],
      research: [],
      items: [],
      placements: [],
    }),
    [anchor, setAnchor] = useState(
      nodes[0] ? `${nodes[0].kind}:${nodes[0].id}` : "",
    ),
    [tab, setTab] = useState("topics"),
    [status, setStatus] = useState("suggested"),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [researchId, setResearchId] = useState(""),
    [history, setHistory] = useState<Revision[]>([]);
  const requests = useRef(new Map<string, string>()),
    initialized = useRef(false);
  async function load() {
    const r = await fetch("/api/knowledge", { cache: "no-store" }),
      data = await r.json();
    if (!r.ok) throw Error(data.error ?? "연결을 불러오지 못했습니다.");
    setState(data);
  }
  async function send(type: string, payload: unknown) {
    const key = JSON.stringify({ type, payload });
    let requestId = requests.current.get(key);
    if (!requestId) {
      requestId = crypto.randomUUID();
      requests.current.set(key, requestId);
    }
    const r = await fetch("/api/knowledge", {
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
    return data;
  }
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "다시 시도해 주세요.");
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    void run(async () => {
      if (anchor) {
        const [kind, id] = anchor.split(":");
        await send("suggest", { kind, id });
      }
    });
  }, []); // One initial source; every further source is chosen by the reader.
  const title = (kind: string, id: string) =>
    nodes.find((n) => n.kind === kind && n.id === id)?.title ?? "자료";
  const choices = nodes
    .filter((n) => n.title.toLowerCase().includes(find.toLowerCase()))
    .slice(0, library.catalog ? 1000 : 100);
  const links = state.connections.filter((c) => c.status === status);
  const selected =
    state.research.find((r) => r.id === researchId) ?? state.research[0];
  const items = state.items.filter((i) => i.research_id === selected?.id);
  function exportResearch() {
    if (!selected) return;
    const content = exportResearchMarkdown(selected, items, state.placements);
    const url = URL.createObjectURL(
      new Blob([content], { type: "text/markdown;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = selected.title.replace(/[<>:"/\\|?*]/g, "_") + ".md";
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <section className="knowledge-panel">
      <div className="knowledge-tabs">
        {[
          ["topics", "주제별 자료"],
          ["timeline", "생각의 흐름"],
          ["review", "검토할 후보"],
        ].map(([id, label]) => (
          <button
            key={id}
            className={tab === id ? "primary" : ""}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
        <button
          className={tab === "connections" ? "primary" : ""}
          onClick={() => setTab("connections")}
        >
          사유의 연결
        </button>
        <button
          className={tab === "research" ? "primary" : ""}
          onClick={() => setTab("research")}
        >
          설교·논문 자료
        </button>
        <button disabled={busy} onClick={() => void run(async () => {})}>
          새로고침
        </button>
        <button
          type="button"
          aria-haspopup="dialog"
          onClick={() => setHelpOpen(true)}
        >
          사용법
        </button>
      </div>
      {helpOpen && <ThoughtMapHelp onClose={() => setHelpOpen(false)} />}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {busy && <p role="status">자료를 연결하고 있습니다…</p>}
      {["topics", "timeline", "review"].includes(tab) ? (
        <ThoughtMapPanel view={tab} library={library} onOpen={onOpen} />
      ) : tab === "connections" ? (
        <>
          <div className="panel knowledge-controls">
            <h2>책에서 생각으로, 생각에서 새로운 질문으로</h2>
            <p>
              공통 표현을 바탕으로 관련 자료를 찾습니다. 자동 제안은 주제의
              유사성만 뜻하며, 근거·반론 여부는 직접 판단해 주세요.
            </p>
            <label>
              연결할 자료 찾기
              <input
                placeholder="책·메모 제목 검색"
                value={find}
                onChange={(e) => setFind(e.target.value)}
              />
            </label>
            {catalog.loading && (
              <p role="status">전체 서재에서 자료를 찾고 있습니다…</p>
            )}
            {catalog.error && (
              <p role="alert">
                {catalog.error}
                <button onClick={catalog.reload}>다시 조회</button>
              </p>
            )}
            {catalog.nextCursor && (
              <button
                type="button"
                disabled={catalog.loading}
                onClick={catalog.more}
              >
                자료 검색 더 보기
              </button>
            )}
            <label>
              출발 자료
              <select
                value={anchor}
                onChange={(e) => {
                  setAnchor(e.target.value);
                  const node = nodes.find(
                    (n) => n.kind + ":" + n.id === e.target.value,
                  );
                  if (node)
                    setChosen((v) => [
                      ...v.filter(
                        (n) => n.kind + ":" + n.id !== e.target.value,
                      ),
                      node,
                    ]);
                }}
              >
                {anchor &&
                  !choices.some((n) => `${n.kind}:${n.id}` === anchor) && (
                    <option value={anchor}>
                      {title(...(anchor.split(":") as [string, string]))}
                    </option>
                  )}
                {choices.map((n) => (
                  <option key={`${n.kind}:${n.id}`} value={`${n.kind}:${n.id}`}>
                    {n.kind === "book" ? "책" : "메모"} · {n.title}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="primary"
              disabled={busy || !anchor}
              onClick={() =>
                void run(async () => {
                  const [kind, id] = anchor.split(":");
                  const r = await send("suggest", { kind, id });
                  setStatus("suggested");
                  setMessage(
                    r.count
                      ? `${r.count}개의 연결 후보를 찾았습니다.`
                      : "새로운 후보가 없습니다. 이미 판단한 연결은 보존합니다.",
                  );
                })
              }
            >
              연결 후보 찾기
            </button>
            <details>
              <summary>내가 직접 연결하기</summary>
              <form
                className="knowledge-controls"
                onSubmit={(e) => {
                  e.preventDefault();
                  const data = new FormData(e.currentTarget),
                    [sourceKind, sourceId] = anchor.split(":"),
                    [targetKind, targetId] = String(data.get("target")).split(
                      ":",
                    );
                  void run(async () => {
                    await send("connect", {
                      sourceKind,
                      sourceId,
                      targetKind,
                      targetId,
                      relation: data.get("relation"),
                      reason: data.get("reason"),
                    });
                    setStatus("accepted");
                  });
                }}
              >
                <label>
                  도착 자료
                  <select name="target" required>
                    {choices
                      .filter((n) => `${n.kind}:${n.id}` !== anchor)
                      .map((n) => (
                        <option key={n.id} value={`${n.kind}:${n.id}`}>
                          {n.title}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  관계
                  <select name="relation">
                    {Object.entries(relationNames).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  연결한 이유
                  <textarea name="reason" maxLength={2000} />
                </label>
                <button disabled={busy || !anchor}>연결 저장</button>
              </form>
            </details>
          </div>
          <div className="knowledge-tabs">
            {[
              ["suggested", "검토할 후보"],
              ["accepted", "승인한 연결"],
              ["rejected", "제외한 연결"],
            ].map(([key, label]) => (
              <button
                className={status === key ? "primary" : ""}
                key={key}
                onClick={() => setStatus(key)}
              >
                {label}{" "}
                {state.connections.filter((c) => c.status === key).length}
              </button>
            ))}
          </div>
          {links.length === 0 ? (
            <p className="notice">
              이 목록에 연결이 없습니다. 출발 자료를 선택해 후보를 찾아보세요.
            </p>
          ) : (
            links.map((link) => (
              <article
                className="panel knowledge-link"
                key={`${link.id}:${link.version}`}
              >
                <div className="connection-path">
                  <button
                    onClick={() => onOpen(link.source_kind, link.source_id)}
                  >
                    {title(link.source_kind, link.source_id)}
                  </button>
                  <span aria-label="연결 방향">
                    →<small>{relationNames[link.relation]}</small>
                  </span>
                  <button
                    onClick={() => onOpen(link.target_kind, link.target_id)}
                  >
                    {title(link.target_kind, link.target_id)}
                  </button>
                </div>
                <form
                  className="knowledge-controls"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const d = new FormData(e.currentTarget);
                    void run(async () => {
                      await send("editConnection", {
                        id: link.id,
                        expectedVersion: link.version,
                        relation: d.get("relation"),
                        reason: d.get("reason"),
                        status: d.get("status"),
                      });
                    });
                  }}
                >
                  <label>
                    관계
                    <select name="relation" defaultValue={link.relation}>
                      {Object.entries(relationNames).map(([k, v]) => (
                        <option key={k} value={k}>
                          {v}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    연결 이유
                    <textarea
                      name="reason"
                      defaultValue={link.reason}
                      maxLength={2000}
                    />
                  </label>
                  <label>
                    내 판단
                    <select name="status" defaultValue={link.status}>
                      <option value="suggested">검토할 후보</option>
                      <option value="accepted">승인</option>
                      <option value="rejected">제외</option>
                    </select>
                  </label>
                  <button disabled={busy}>판단·수정 저장</button>
                  <button
                    type="button"
                    onClick={() =>
                      void run(async () => {
                        const r = await fetch(`/api/revisions/${link.id}`, {
                          cache: "no-store",
                        });
                        if (!r.ok) throw Error("수정 이력을 읽지 못했습니다.");
                        setHistory(await r.json());
                      })
                    }
                  >
                    수정 이력
                  </button>
                </form>
              </article>
            ))
          )}
          {history.length > 0 && (
            <details open className="panel">
              <summary>연결 수정 이력</summary>
              {history.map((h) => (
                <p key={h.id}>
                  {new Date(h.createdAt).toLocaleString("ko-KR")} ·{" "}
                  {String((h.after as Record<string, unknown>).reason ?? "")} ·{" "}
                  {String((h.after as Record<string, unknown>).status ?? "")}
                </p>
              ))}
            </details>
          )}
        </>
      ) : (
        <>
          <form
            className="panel knowledge-controls"
            onSubmit={(e) => {
              e.preventDefault();
              const d = new FormData(e.currentTarget);
              void run(async () => {
                const r = await send("createResearch", {
                  title: d.get("title"),
                  kind: d.get("kind"),
                  question: d.get("question"),
                });
                setResearchId(r.id);
              });
            }}
          >
            <h2>연구 질문을 중심으로 모으기</h2>
            <label>
              제목
              <input name="title" required maxLength={300} />
            </label>
            <label>
              용도
              <select name="kind">
                <option value="sermon">설교</option>
                <option value="thesis">박사논문</option>
              </select>
            </label>
            <label>
              탐구할 질문
              <textarea name="question" maxLength={2000} />
            </label>
            <button disabled={busy}>자료 묶음 만들기</button>
          </form>
          {selected && (
            <div className="panel knowledge-controls">
              <label>
                자료 묶음
                <select
                  value={selected.id}
                  onChange={(e) => setResearchId(e.target.value)}
                >
                  {state.research.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.kind === "sermon" ? "설교" : "논문"} · {r.title}
                    </option>
                  ))}
                </select>
              </label>
              <p>{selected.question}</p>
              <p>
                담을 당시의 메모와 서지정보를 보존합니다. 원래 메모를 수정해도
                이 자료는 유지됩니다.
              </p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const d = new FormData(e.currentTarget);
                  void run(async () => {
                    await send("addResearchNote", {
                      researchId: selected.id,
                      noteId: d.get("noteId"),
                    });
                  });
                }}
              >
                <label>
                  담을 메모
                  <select name="noteId" required>
                    {library.notes.map((n) => (
                      <option key={n.id} value={n.id}>
                        {n.title} · {n.content.slice(0, 50)}
                      </option>
                    ))}
                  </select>
                </label>
                <button disabled={busy || !library.notes.length}>
                  출처와 함께 담기
                </button>
              </form>
              <button onClick={exportResearch}>문서로 내려받기 (.md)</button>
            </div>
          )}
          {selected && (
            <>
              <p>
                <a
                  href={`/api/bibliography?researchId=${selected.id}&format=csl`}
                >
                  Zotero 서지 (.json)
                </a>{" "}
                ·{" "}
                <a
                  href={`/api/bibliography?researchId=${selected.id}&format=ris`}
                >
                  서지 (.ris)
                </a>
              </p>
              <ResearchBoard
                items={items}
                placements={state.placements}
                busy={busy}
                onOpen={onOpen}
                onSave={(payload) =>
                  void run(async () => {
                    await send("placeResearchItem", payload);
                  })
                }
              />
            </>
          )}
          {!selected && (
            <p>
              설교나 논문의 연구 질문을 정하고, 책에서 찾은 근거와 나의 생각을
              모아 보세요.
            </p>
          )}
        </>
      )}
    </section>
  );
}
