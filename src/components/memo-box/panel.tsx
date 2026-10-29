"use client";
import { useEffect, useMemo, useState } from "react";
import { buildMemoBox } from "@/lib/memo-box";
import { containsSearchField } from "@/lib/search-fields";
import type { WhiteboardSnapshot } from "@/lib/whiteboard";
import type { Library, Command } from "@/lib/domain";
import type { NewNoteContext } from "@/lib/note-context";
import { usePagedResource } from "../use-paged-resource";
import { useLibraryCommand } from "../use-library-command";
import {
  useListPagination,
  PageNavigation,
  PageSizeSelect,
} from "../list-pagination";
import { ThoughtBoxes } from "./thought-boxes";
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
    [selected, setSelected] = useState("");
  const tabKey = "library:memo-box-tab:" + ownerId;
  useEffect(() => {
    try {
      const stored = localStorage.getItem(tabKey);
      const saved = stored === "topics" ? "bundles" : stored;
      setTab(
        initialTag !== "all"
          ? "records"
          : saved && ["records", "notes", "bundles"].includes(saved)
            ? saved
            : "records",
      );
      if (stored === "topics") localStorage.setItem(tabKey, "bundles");
      if (stored === "writing") localStorage.setItem(tabKey, "records");
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
    tab === "notes",
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
  const active = model?.groups.find((g) => g.id === selected);
  return (
    <section className="memo-box">
      <div className="knowledge-tabs">
        {[
          ["records", "내 기록"],
          ["notes", "연결된 메모"],
          ["bundles", "생각 묶음"],
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
      {tab === "notes" && (resource.error || command.error) && (
        <p role="alert">
          {resource.error || command.error}
          <button onClick={resource.reload}>다시 조회</button>
        </p>
      )}
      {tab === "notes" && !model && resource.loading && (
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
      ) : tab === "bundles" ? null : model && tab === "notes" ? (
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
      ) : null}
      <ThoughtBoxes
        enabled={tab === "bundles"}
        revision={refresh}
        onOpen={onOpen}
      />
    </section>
  );
}
