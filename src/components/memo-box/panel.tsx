"use client";
import { useMemo, useState } from "react";
import { buildMemoBox } from "@/lib/memo-box";
import { containsSearchField } from "@/lib/search-fields";
import type { WhiteboardSnapshot } from "@/lib/whiteboard";
import type { Library } from "@/lib/domain";
import type { NewNoteContext, NoteTopicSnapshot } from "@/lib/note-context";
import { type Relation } from "@/lib/knowledge";
import { usePagedResource } from "../use-paged-resource";
import { useLibraryCommand } from "../use-library-command";
import {
  useListPagination,
  PageNavigation,
  PageSizeSelect,
} from "../list-pagination";
import { TopicEditor } from "./topic-editor";
import { ConnectionEditor } from "./connection-editor";
import { WritingWorkbench } from "./writing-workbench";
export function MemoBox({
  library,
  onOpen,
  onNewNote,
  revision,
}: {
  library: Library;
  onOpen: (kind: string, id: string) => void;
  onNewNote: (c: NewNoteContext) => void;
  revision?: number;
}) {
  const refresh = useMemo(
    () => ({ notes: library.notes, revision }),
    [library.notes, revision],
  );
  const resource = usePagedResource<WhiteboardSnapshot>(
    "/api/whiteboard",
    true,
    refresh,
    { keepPreviousData: true },
  );
  const command = useLibraryCommand("/api/knowledge", resource.reload);
  const [tab, setTab] = useState("notes"),
    [query, setQuery] = useState(""),
    [selected, setSelected] = useState("");
  const paging = useListPagination("memo-box", tab + query);
  const model = useMemo(
    () => (resource.data ? buildMemoBox(resource.data) : null),
    [resource.data],
  );
  const shown = useMemo(
    () =>
      model?.connected.filter((n) =>
        containsSearchField([n.title, n.content].join(" "), query),
      ) ?? [],
    [model, query],
  );
  const active = model?.notes.get(selected),
    pairs = (model?.topicPairs ?? []).filter((p) =>
      containsSearchField(
        [
          model?.topics.get(p.source)?.name,
          model?.topics.get(p.target)?.name,
        ].join(" "),
        query,
      ),
    );
  return (
    <section className="memo-box">
      <div className="knowledge-tabs">
        {[
          ["notes", "연결된 메모"],
          ["topics", "연결된 주제"],
          ["writing", "글감 엮기"],
        ].map(([id, label]) => (
          <button
            key={id}
            className={tab === id ? "primary" : ""}
            onClick={() => {
              setTab(id);
              setQuery("");
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {(resource.error || command.error) && (
        <p role="alert">
          {resource.error || command.error}
          <button onClick={resource.reload}>다시 조회</button>
        </p>
      )}
      {!model && resource.loading && <p role="status">메모 상자를 여는 중…</p>}
      {tab === "writing" ? (
        <WritingWorkbench
          library={library}
          notes={resource.data?.notes ?? []}
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
                  .map((n) => (
                    <button
                      className={selected === n.id ? "selected" : ""}
                      key={n.id}
                      onClick={() => setSelected(n.id)}
                    >
                      <strong>{n.title || n.content.slice(0, 50)}</strong>
                      <small>
                        {model.connections.get(n.id)?.length}개 연결 ·{" "}
                        {(model.noteTopics.get(n.id) ?? [])
                          .map((id) => model.topics.get(id)?.name)
                          .join(", ") || "미분류"}
                      </small>
                      <p>{n.content.slice(0, 150)}</p>
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
                <>
                  <h3>{active.title || "메모"}</h3>
                  <p className="preserve-text">{active.content}</p>
                  <div className="form-footer">
                    <button onClick={() => onOpen("note", active.id)}>
                      메모 수정·분류
                    </button>
                    <button
                      onClick={() =>
                        onNewNote({
                          relatedNotes: [
                            { id: active.id, title: active.title },
                          ],
                          topicIds: model.noteTopics.get(active.id),
                        })
                      }
                    >
                      관련 기록 남기기
                    </button>
                  </div>
                  {(model.connections.get(active.id) ?? []).map((c) => {
                    const other = model.notes.get(
                      c.source_id === active.id ? c.target_id : c.source_id,
                    )!;
                    return (
                      <article className="memo-box-edge" key={c.id}>
                        <button
                          className="thought-title"
                          onClick={() => setSelected(other.id)}
                        >
                          {other.title || other.content.slice(0, 50)}
                        </button>
                        <p>{other.content.slice(0, 250)}</p>
                        <small>
                          {model.notes.get(c.source_id)?.title || "메모"} →{" "}
                          {model.notes.get(c.target_id)?.title || "메모"}
                        </small>
                        <ConnectionEditor
                          connection={c}
                          busy={command.busy}
                          onSave={(payload) =>
                            command.send("editConnection", payload)
                          }
                        />
                        <button
                          disabled={command.busy}
                          onClick={() =>
                            void command.send("editConnection", {
                              id: c.id,
                              expectedVersion: c.version,
                              relation: c.relation as Relation,
                              reason: c.reason,
                              status: "rejected",
                            })
                          }
                        >
                          연결 끊기
                        </button>
                      </article>
                    );
                  })}
                </>
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
            <div className="memo-topic-pairs">
              {pairs
                .slice(paging.offset, paging.offset + paging.size)
                .map((p) => (
                  <TopicPair
                    key={p.id}
                    pair={p}
                    model={model}
                    onOpen={onOpen}
                    onNewNote={onNewNote}
                    reload={resource.reload}
                  />
                ))}
              {!pairs.length && (
                <p>
                  연결된 주제가 없습니다. 화이트보드에서 주제 묶음을 연결하거나,
                  서로 다른 주제의 메모를 연결해 보세요.
                </p>
              )}
            </div>
            <PageNavigation
              label="메모 상자"
              paging={paging}
              total={pairs.length}
            />
          </>
        )
      )}
    </section>
  );
}
function TopicPair({
  pair: p,
  model,
  onOpen,
  onNewNote,
  reload,
}: {
  pair: ReturnType<typeof buildMemoBox>["topicPairs"][number];
  model: ReturnType<typeof buildMemoBox>;
  onOpen: (k: string, id: string) => void;
  onNewNote: (c: NewNoteContext) => void;
  reload: () => void;
}) {
  const [editing, setEditing] = useState("");
  const data = usePagedResource<NoteTopicSnapshot>(
    "/api/note-topics",
    !!editing,
  );
  const command = useLibraryCommand("/api/thought-map", () => {
    reload();
    data.reload();
  });
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
    <article className="panel">
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
      <details>
        <summary>관련 메모 보기</summary>
        {related.map((n) => (
          <p key={n.id}>
            <button onClick={() => onOpen("note", n.id)}>
              {n.title || n.content.slice(0, 60)}
            </button>
            {evidenceIds.has(n.id) && <small> · 연결 근거</small>}
          </p>
        ))}
        {!evidenceIds.size && (
          <p>메모 간 근거 연결이 없는 주제 묶음 연결입니다.</p>
        )}
      </details>
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
