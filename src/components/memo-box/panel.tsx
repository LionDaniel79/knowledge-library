"use client";
import { useEffect, useMemo, useState } from "react";
import { buildMemoBox } from "@/lib/memo-box";
import { containsSearchField } from "@/lib/search-fields";
import type { WhiteboardSnapshot } from "@/lib/whiteboard";
import type { Library, Command } from "@/lib/domain";
import type { NewNoteContext, NoteTopicSnapshot } from "@/lib/note-context";
import type { ThoughtMapSnapshot } from "@/lib/thought-map/types";
import { libraryRequest } from "@/client/replica/request";
import { usePagedResource } from "../use-paged-resource";
import { useLibraryCommand } from "../use-library-command";
import {
  useListPagination,
  PageNavigation,
  PageSizeSelect,
} from "../list-pagination";
import { TopicEditor } from "./topic-editor";
import { MemoGroupDetail } from "./group-detail";
import { ThoughtMapPanel } from "../thought-map/panel";
export function MemoBox({
  library,
  onOpen,
  onNewNote,
  revision,
  ownerId = "",
  initialTag = "all",
  onUpdated,
  onSaveNote,
}: {
  library: Library;
  onOpen: (kind: string, id: string) => void;
  onNewNote: (c: NewNoteContext) => void;
  revision?: number;
  ownerId?: string;
  initialTag?: string;
  onUpdated?: () => Promise<void>;
  onSaveNote?: (c: Command) => Promise<void>;
}) {
  const [tab, setTab] = useState("records"),
    [query, setQuery] = useState(""),
    [selected, setSelected] = useState(""),
    [selectedPair, setSelectedPair] = useState("");
  const tabKey = "library:memo-box-tab:" + ownerId;
  useEffect(() => {
    try {
      const saved = localStorage.getItem(tabKey);
      setTab(
        initialTag !== "all"
          ? "records"
          : saved && ["records", "notes", "topics"].includes(saved)
            ? saved
            : "records",
      );
      if (saved === "writing") localStorage.setItem(tabKey, "records");
    } catch {
      setTab("records");
    }
  }, [tabKey, initialTag]);
  const refresh = useMemo(
    () => ({ notes: library.notes, revision }),
    [library.notes, revision],
  );
  const resource = usePagedResource<WhiteboardSnapshot>(
    "/api/whiteboard",
    tab !== "records",
    refresh,
    { keepPreviousData: true },
  );
  const command = useLibraryCommand("/api/knowledge", resource.reload);
  const paging = useListPagination("memo-box", tab + query);
  const model = useMemo(
    () => (resource.data ? buildMemoBox(resource.data) : null),
    [resource.data],
  );
  const shown = useMemo(
    () =>
      model?.groups.filter((group) =>
        group.notes.some((n) =>
          containsSearchField([n.title, n.content].join(" "), query),
        ),
      ) ?? [],
    [model, query],
  );
  const active = model?.groups.find((g) => g.id === selected),
    pairs = (model?.topicPairs ?? []).filter((p) =>
      containsSearchField(
        [
          model?.topics.get(p.source)?.name,
          model?.topics.get(p.target)?.name,
        ].join(" "),
        query,
      ),
    );
  const activePair = pairs.find((pair) => pair.id === selectedPair);
  return (
    <section className="memo-box">
      <div className="knowledge-tabs">
        {[
          ["records", "내 기록"],
          ["notes", "연결된 메모"],
          ["topics", "연결된 주제"],
        ].map(([id, label]) => (
          <button
            key={id}
            className={tab === id ? "primary" : ""}
            onClick={() => {
              setTab(id);
              try {
                localStorage.setItem(tabKey, id);
              } catch {}
              setQuery("");
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {tab !== "records" && (resource.error || command.error) && (
        <p role="alert">
          {resource.error || command.error}
          <button onClick={resource.reload}>다시 조회</button>
        </p>
      )}
      {tab !== "records" && !model && resource.loading && (
        <p role="status">메모 상자를 여는 중…</p>
      )}
      {tab === "records" ? (
        <ThoughtMapPanel
          initialTag={initialTag}
          library={library}
          ownerId={ownerId}
          onUpdated={onUpdated}
          onSaveNote={onSaveNote}
          onNewNote={onNewNote}
          onOpen={onOpen}
          revision={revision}
        />
      ) : model && tab === "notes" ? (
        <>
          <div className="memo-box-toolbar">
            <label>
              메모 찾기
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="제목·내용"
              />
            </label>
            <PageSizeSelect label="메모 상자" paging={paging} />
          </div>
          <div className="memo-box-columns">
            <div>
              <div className="memo-box-list">
                {shown
                  .slice(paging.offset, paging.offset + paging.size)
                  .map((group) => (
                    <button
                      className={selected === group.id ? "selected" : ""}
                      key={group.id}
                      onClick={() => setSelected(group.id)}
                    >
                      {group.notes.map((n) => (
                        <span className="memo-group-title" key={n.id}>
                          {n.title || n.content.slice(0, 50)}
                        </span>
                      ))}
                    </button>
                  ))}
              </div>
              {!shown.length && (
                <p>
                  연결된 메모가 없습니다. 화이트보드에서 메모를 연결해 보세요.
                </p>
              )}
              <PageNavigation
                label="메모 상자"
                paging={paging}
                total={shown.length}
              />
            </div>
            <div className="panel memo-box-detail">
              {active ? (
                <MemoGroupDetail
                  group={active}
                  onOpen={onOpen}
                  onNewNote={onNewNote}
                  topicIdsForNote={(id) => model.noteTopics.get(id)}
                  busy={command.busy}
                  onSave={(p) => command.send("editConnection", p)}
                  onRemove={(c) =>
                    void command.send("editConnection", {
                      id: c.id,
                      expectedVersion: c.version,
                      relation: c.relation,
                      reason: c.reason,
                      status: "rejected",
                    })
                  }
                />
              ) : (
                <p>메모를 선택하면 연결과 내용을 볼 수 있습니다.</p>
              )}
            </div>
          </div>
        </>
      ) : (
        model && (
          <>
            <div className="memo-box-toolbar">
              <label>
                주제 찾기
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="주제 이름"
                />
              </label>
              <PageSizeSelect label="메모 상자" paging={paging} />
            </div>
            <div className="memo-box-columns">
              <div>
                <div className="memo-box-list memo-topic-list">
                  {pairs
                    .slice(paging.offset, paging.offset + paging.size)
                    .map((p) => (
                      <button
                        type="button"
                        key={p.id}
                        className={selectedPair === p.id ? "selected" : ""}
                        aria-pressed={selectedPair === p.id}
                        onClick={() => setSelectedPair(p.id)}
                      >
                        <span className="memo-group-title">
                          {model.topics.get(p.source)?.name} ↔{" "}
                          {model.topics.get(p.target)?.name}
                        </span>
                        <small>
                          {p.topicLinkIds.length
                            ? `주제 연결 ${p.topicLinkIds.length}개 · `
                            : ""}
                          {p.board ? "화이트보드 연결 · " : ""}메모 연결{" "}
                          {p.connectionIds.length}개
                        </small>
                      </button>
                    ))}
                </div>
                {!pairs.length && (
                  <p>
                    연결된 주제가 없습니다. 화이트보드에서 주제 묶음을
                    연결하거나, 서로 다른 주제의 메모를 연결해 보세요.
                  </p>
                )}
                <PageNavigation
                  label="메모 상자"
                  paging={paging}
                  total={pairs.length}
                />
              </div>
              <div className="panel memo-box-detail memo-topic-detail">
                {activePair && resource.data ? (
                  <TopicPair
                    key={activePair.id}
                    pair={activePair}
                    model={model}
                    source={resource.data}
                    onOpen={onOpen}
                    onNewNote={onNewNote}
                    reload={resource.reload}
                  />
                ) : (
                  <p>주제를 선택하면 연결과 관련 메모를 볼 수 있습니다.</p>
                )}
              </div>
            </div>
          </>
        )
      )}
    </section>
  );
}
function TopicPair({
  pair: p,
  model,
  source,
  onOpen,
  onNewNote,
  reload,
}: {
  pair: ReturnType<typeof buildMemoBox>["topicPairs"][number];
  model: ReturnType<typeof buildMemoBox>;
  source: WhiteboardSnapshot;
  onOpen: (k: string, id: string) => void;
  onNewNote: (c: NewNoteContext) => void;
  reload: () => void;
}) {
  const [editing, setEditing] = useState(""),
    [removing, setRemoving] = useState(false),
    [removeError, setRemoveError] = useState("");
  const data = usePagedResource<NoteTopicSnapshot>(
    "/api/note-topics",
    !!editing,
  );
  const command = useLibraryCommand("/api/thought-map", () => {
    reload();
    data.reload();
  });
  const knowledge = useLibraryCommand("/api/knowledge", reload);
  const busy = removing || command.busy || knowledge.busy;
  async function removeTopicLink(id: string) {
    if (busy) return;
    setRemoving(true);
    setRemoveError("");
    try {
      const listed = source.topicLinks?.find((link) => link.id === id);
      let version = listed && "version" in listed ? listed.version : undefined;
      if (typeof version !== "number") {
        const response = await libraryRequest("/api/thought-map", {
            cache: "no-store",
          }),
          snapshot = (await response.json()) as ThoughtMapSnapshot;
        if (!response.ok) throw Error("최근 주제 연결을 불러오지 못했습니다.");
        const latest = snapshot.topicLinks.find((link) => link.id === id);
        if (!latest || latest.status !== "accepted") {
          reload();
          return;
        }
        version = latest.version;
      }
      await command.send("decideTopicLink", {
        id,
        expectedVersion: version,
        status: "rejected",
      });
    } catch (error) {
      setRemoveError((error as Error).message);
    } finally {
      setRemoving(false);
    }
  }
  const topic = data.data?.topics.find((t) => t.id === editing);
  const evidenceIds = new Set(
    model.edges
      .filter((c) => p.connectionIds.includes(c.id))
      .flatMap((c) => [c.source_id, c.target_id]),
  );
  const related = [...model.notes.values()].filter((n) =>
    (model.noteTopics.get(n.id) ?? []).some(
      (id) => id === p.source || id === p.target,
    ),
  );
  return (
    <article>
      <h3>
        {model.topics.get(p.source)?.name} ↔ {model.topics.get(p.target)?.name}
      </h3>
      <small>
        {p.board ? "화이트보드 주제 연결 · " : ""}
        {p.topicLinkIds.length ? "확인한 주제 연결 · " : ""}근거 메모 연결{" "}
        {p.connectionIds.length}개
      </small>
      <div className="form-footer">
        {[p.source, p.target].map((id) => (
          <button key={id} onClick={() => setEditing(id)}>
            {model.topics.get(id)?.name} 수정
          </button>
        ))}
        <button onClick={() => onNewNote({ topicIds: [p.source, p.target] })}>
          두 주제에 기록 남기기
        </button>
      </div>
      {(removeError || command.error || knowledge.error) && (
        <p role="alert">{removeError || command.error || knowledge.error}</p>
      )}
      <section aria-label="주제 연결">
        {p.topicLinkIds.map((id) => (
          <p key={id}>
            확인한 주제 연결{" "}
            <button
              type="button"
              disabled={busy}
              onClick={() => void removeTopicLink(id)}
            >
              주제 연결 끊기
            </button>
          </p>
        ))}
        {p.board && (
          <p>
            화이트보드의 주제 묶음 연결{" "}
            <button
              type="button"
              disabled={busy || !source.board}
              onClick={() => {
                const board = source.board;
                if (!board) return;
                void knowledge.send("saveWhiteboard", {
                  boardId: board.id,
                  expectedVersion: board.version,
                  data: {
                    ...board.data,
                    links: board.data.links.filter(
                      (link) =>
                        !(
                          [link.source, link.target].includes(
                            "topic:" + p.source,
                          ) &&
                          [link.source, link.target].includes(
                            "topic:" + p.target,
                          )
                        ),
                    ),
                  },
                });
              }}
            >
              화이트보드 연결 끊기
            </button>
          </p>
        )}
        {model.edges
          .filter((edge) => p.connectionIds.includes(edge.id))
          .map((edge) => (
            <div className="memo-box-edge" key={edge.id}>
              <h4>
                {model.notes.get(edge.source_id)?.title || "메모"} ↔{" "}
                {model.notes.get(edge.target_id)?.title || "메모"}
              </h4>
              <p className="preserve-text">{edge.reason}</p>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void knowledge.send("editConnection", {
                    id: edge.id,
                    expectedVersion: edge.version,
                    relation: edge.relation,
                    reason: edge.reason,
                    status: "rejected",
                  })
                }
              >
                메모 연결 끊기
              </button>
            </div>
          ))}
      </section>
      <section className="memo-topic-related" aria-label="관련 메모">
        <h4>관련 메모</h4>
        {related.map((n) => (
          <details className="memo-group-note" key={n.id}>
            <summary>
              {n.title || n.content.slice(0, 60)}
              {evidenceIds.has(n.id) && <small> · 연결 근거</small>}
            </summary>
            <p className="preserve-text">{n.content}</p>
            <button onClick={() => onOpen("note", n.id)}>메모 수정·분류</button>
          </details>
        ))}
        {!evidenceIds.size && (
          <p>메모 간 근거 연결이 없는 주제 묶음 연결입니다.</p>
        )}
      </section>
      {editing && !topic && (
        <p role={data.error ? "alert" : "status"}>
          {data.error || "주제 불러오는 중…"}{" "}
          {data.error && <button onClick={data.reload}>다시 조회</button>}
          <button onClick={() => setEditing("")}>취소</button>
        </p>
      )}
      {topic && (
        <TopicEditor
          key={topic.id}
          topic={topic}
          topics={data.data!.topics}
          busy={command.busy}
          error={command.error}
          onClose={() => setEditing("")}
          onSave={async (payload) => {
            if (await command.send("upsertTopic", payload)) setEditing("");
          }}
        />
      )}
    </article>
  );
}
