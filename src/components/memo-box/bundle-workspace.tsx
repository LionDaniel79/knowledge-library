"use client";
import { useEffect, useState } from "react";
import type { WhiteboardSnapshot } from "@/lib/whiteboard";
import {
  bundleRelations,
  activeBundleLinks,
  type MemoBundle,
  type BundleLink,
} from "@/lib/thought-bundles";
import { containsSearchField } from "@/lib/search-fields";
import { useLibraryCommand } from "../use-library-command";

export function BundleWorkspace({
  source,
  mode,
  onSaved,
  onOpen,
  initialNoteIds = [],
  initialBundleId,
  initialLinkId,
  onNewNote,
  onStored,
}: {
  source: WhiteboardSnapshot;
  mode: "bundles" | "links";
  onSaved: () => void;
  onOpen: (kind: string, id: string) => void;
  initialNoteIds?: string[];
  initialBundleId?: string;
  initialLinkId?: string;
  onStored?: (id: string) => void;
  onNewNote?: (context: {
    relatedNotes: { id: string; title: string }[];
  }) => void;
}) {
  const bundles = (source.bundles ?? []).filter((b) => !b.archived_at),
    links = activeBundleLinks(bundles, source.bundleLinks ?? []);
  const blank = (): MemoBundle => ({
    id: "",
    title: "",
    description: "",
    note_ids: initialNoteIds,
    version: 0,
    archived_at: null,
  });
  const [draft, setDraft] = useState<MemoBundle>(
    () => bundles.find((b) => b.id === initialBundleId) ?? blank(),
  );
  const [query, setQuery] = useState(""),
    [noteQuery, setNoteQuery] = useState(""),
    [page, setPage] = useState(0),
    [message, setMessage] = useState("");
  const [link, setLink] = useState<Partial<BundleLink>>(
    () =>
      links.find((l) => l.id === initialLinkId) ?? {
        relation: "related",
        reason: "",
        status: "accepted",
        version: 0,
      },
  );
  const command = useLibraryCommand("/api/knowledge", onSaved);
  useEffect(() => {
    if (initialLinkId && !link.id) {
      const found = source.bundleLinks?.find((l) => l.id === initialLinkId);
      if (found) setLink(found);
    }
  }, [initialLinkId, source.bundleLinks, link.id]);
  const noteMap = new Map(source.notes.map((n) => [n.id, n]));
  const shown = source.notes.filter((n) =>
    containsSearchField(n.title + " " + n.content, noteQuery),
  );
  const choose = (b: MemoBundle) => {
    setDraft({
      ...b,
      note_ids: [...new Set([...b.note_ids, ...initialNoteIds])],
    });
    setMessage("");
    setNoteQuery("");
    setPage(0);
  };
  const chooseLink = (l: BundleLink) => {
    setLink(l);
    setMessage("");
  };
  const pickPair = (field: "source_id" | "target_id", id: string) => {
    const next = { ...link, [field]: id },
      old = (source.bundleLinks ?? []).find(
        (l) =>
          [l.source_id, l.target_id].includes(next.source_id ?? "") &&
          [l.source_id, l.target_id].includes(next.target_id ?? "") &&
          next.source_id !== next.target_id,
      );
    setLink(
      old
        ? { ...old, source_id: next.source_id, target_id: next.target_id }
        : { ...next, id: undefined, version: 0 },
    );
  };
  async function saveLink(status = "accepted") {
    const result = await command.send("saveBundleLink", {
      ...(link.id ? { id: link.id } : {}),
      sourceId: link.source_id,
      targetId: link.target_id,
      relation: link.relation ?? "related",
      reason: link.reason ?? "",
      status,
      expectedVersion: link.version ?? 0,
    });
    if (result) {
      setLink({ ...link, id: result.id, version: result.version, status });
      setMessage(
        status === "rejected"
          ? "묶음 연결을 끊었습니다."
          : "묶음 연결을 저장했습니다.",
      );
    }
  }
  return (
    <section
      className="bundle-workspace"
      aria-label={mode === "bundles" ? "생각 묶음 관리" : "묶음 연결 관리"}
    >
      {(command.error || message) && (
        <p role={command.error ? "alert" : "status"}>
          {command.error || message}
        </p>
      )}
      <div className="memo-box-toolbar">
        <label>
          묶음 찾기
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="이름·정리 내용"
          />
        </label>
        <button
          type="button"
          disabled={command.busy}
          onClick={() => {
            if (mode === "bundles") {
              setDraft(blank());
              setNoteQuery("");
              setPage(0);
            } else
              setLink({
                relation: "related",
                reason: "",
                version: 0,
                status: "accepted",
              });
            setMessage("");
          }}
        >
          {mode === "bundles" ? "새 생각 묶음" : "새 묶음 연결"}
        </button>
      </div>
      <div className="memo-box-columns">
        <div className="memo-box-list">
          {mode === "bundles"
            ? bundles
                .filter((b) =>
                  containsSearchField(b.title + " " + b.description, query),
                )
                .map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    aria-pressed={draft.id === b.id}
                    className={draft.id === b.id ? "selected" : ""}
                    onClick={() => choose(b)}
                  >
                    <span>{b.title}</span>
                    <small>{b.note_ids.length}개 메모</small>
                  </button>
                ))
            : links
                .filter((l) =>
                  containsSearchField(
                    bundles.find((b) => b.id === l.source_id)?.title +
                      " " +
                      bundles.find((b) => b.id === l.target_id)?.title,
                    query,
                  ),
                )
                .map((l) => (
                  <button
                    key={l.id}
                    type="button"
                    className={link.id === l.id ? "selected" : ""}
                    onClick={() => chooseLink(l)}
                  >
                    {bundles.find((b) => b.id === l.source_id)?.title} ↔{" "}
                    {bundles.find((b) => b.id === l.target_id)?.title}
                  </button>
                ))}
        </div>
        <div className="panel memo-box-detail">
          {mode === "bundles" ? (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const result = await command.send("saveMemoBundle", {
                  ...(draft.id ? { id: draft.id } : {}),
                  title: draft.title,
                  description: draft.description,
                  noteIds: draft.note_ids,
                  expectedVersion: draft.version,
                });
                if (result) {
                  setDraft({
                    ...draft,
                    id: result.id,
                    version: result.version,
                  });
                  setMessage("생각 묶음을 저장했습니다.");
                  onStored?.(result.id);
                }
              }}
            >
              <fieldset disabled={command.busy}>
                <label>
                  생각 묶음 이름
                  <input
                    aria-label="생각 묶음 이름"
                    value={draft.title}
                    maxLength={80}
                    required
                    onChange={(e) =>
                      setDraft({ ...draft, title: e.target.value })
                    }
                  />
                </label>
                <label>
                  묶음에 대한 정리
                  <textarea
                    aria-label="묶음에 대한 정리"
                    rows={4}
                    value={draft.description}
                    maxLength={20000}
                    onChange={(e) =>
                      setDraft({ ...draft, description: e.target.value })
                    }
                  />
                </label>
                <details
                  open={draft.note_ids.length < 6}
                  className="bundle-members"
                >
                  <summary>담긴 메모 {draft.note_ids.length}개</summary>
                  {draft.note_ids.map((id, i) => {
                    const note = noteMap.get(id);
                    return (
                      <div className="bundle-member" key={id}>
                        <button
                          type="button"
                          disabled={!note}
                          onClick={() => onOpen("note", id)}
                        >
                          {i + 1}.{" "}
                          {note?.title ||
                            note?.content.slice(0, 45) ||
                            "휴지통 또는 삭제된 메모"}
                        </button>
                        <button
                          type="button"
                          aria-label={`${note?.title || "메모"} 묶음에서 빼기`}
                          onClick={() =>
                            setDraft({
                              ...draft,
                              note_ids: draft.note_ids.filter((n) => n !== id),
                            })
                          }
                        >
                          빼기
                        </button>
                      </div>
                    );
                  })}
                </details>
                <label>
                  담을 메모 검색
                  <input
                    type="search"
                    aria-label="담을 메모 검색"
                    placeholder="메모 제목·내용"
                    value={noteQuery}
                    onChange={(e) => {
                      setNoteQuery(e.target.value);
                      setPage(0);
                    }}
                  />
                </label>
                <div className="bundle-note-picker">
                  {shown.slice(page * 15, page * 15 + 15).map((n) => (
                    <label key={n.id}>
                      <input
                        type="checkbox"
                        aria-label={`${n.title || n.content.slice(0, 30)} 선택`}
                        checked={draft.note_ids.includes(n.id)}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            note_ids: e.target.checked
                              ? [...draft.note_ids, n.id]
                              : draft.note_ids.filter((id) => id !== n.id),
                          })
                        }
                      />
                      <span>
                        {n.title || n.content.slice(0, 45)}
                        <small>{n.content.slice(0, 85)}</small>
                      </span>
                    </label>
                  ))}
                </div>
                {shown.length > 15 && (
                  <div className="form-footer">
                    <button
                      type="button"
                      disabled={!page}
                      onClick={() => setPage(page - 1)}
                    >
                      이전
                    </button>
                    <small>
                      {page + 1} / {Math.ceil(shown.length / 15)}
                    </small>
                    <button
                      type="button"
                      disabled={(page + 1) * 15 >= shown.length}
                      onClick={() => setPage(page + 1)}
                    >
                      다음
                    </button>
                  </div>
                )}
                <div className="form-footer">
                  <button className="primary">생각 묶음 저장</button>
                  {draft.id && (
                    <button
                      type="button"
                      onClick={async () => {
                        if (
                          !confirm(
                            `‘${draft.title}’ 생각 묶음을 보관해제할까요? 원래 메모와 메모 연결은 유지됩니다.`,
                          )
                        )
                          return;
                        const result = await command.send("archiveMemoBundle", {
                          id: draft.id,
                          expectedVersion: draft.version,
                        });
                        if (result) setDraft(blank());
                      }}
                    >
                      묶음 보관해제
                    </button>
                  )}
                  {onNewNote && draft.note_ids.length > 0 && (
                    <button
                      type="button"
                      onClick={() =>
                        onNewNote({
                          relatedNotes: draft.note_ids.flatMap((id) => {
                            const n = noteMap.get(id);
                            return n ? [{ id, title: n.title }] : [];
                          }),
                        })
                      }
                    >
                      관련 기록 남기기
                    </button>
                  )}
                </div>
              </fieldset>
            </form>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void saveLink();
              }}
            >
              {initialLinkId && !link.id && (
                <p role="status">연결을 불러오는 중…</p>
              )}
              <fieldset
                disabled={command.busy || (!!initialLinkId && !link.id)}
              >
                <label>
                  출발 생각 묶음
                  <select
                    aria-label="출발 생각 묶음"
                    value={link.source_id ?? ""}
                    onChange={(e) => pickPair("source_id", e.target.value)}
                    required
                  >
                    <option value="">선택</option>
                    {bundles.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.title}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  도착 생각 묶음
                  <select
                    aria-label="도착 생각 묶음"
                    value={link.target_id ?? ""}
                    onChange={(e) => pickPair("target_id", e.target.value)}
                    required
                  >
                    <option value="">선택</option>
                    {bundles
                      .filter((b) => b.id !== link.source_id)
                      .map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.title}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  묶음 관계
                  <select
                    aria-label="묶음 관계"
                    value={link.relation ?? "related"}
                    onChange={(e) =>
                      setLink({
                        ...link,
                        relation: e.target.value as BundleLink["relation"],
                      })
                    }
                  >
                    {Object.entries(bundleRelations).map(([id, label]) => (
                      <option key={id} value={id}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  묶음 연결 이유
                  <textarea
                    aria-label="묶음 연결 이유"
                    rows={4}
                    value={link.reason ?? ""}
                    maxLength={4000}
                    onChange={(e) =>
                      setLink({ ...link, reason: e.target.value })
                    }
                  />
                </label>
                <div className="form-footer">
                  <button className="primary">묶음 연결 저장</button>
                  {link.id && link.status === "accepted" && (
                    <button
                      type="button"
                      onClick={() => void saveLink("rejected")}
                    >
                      묶음 연결 끊기
                    </button>
                  )}
                </div>
              </fieldset>
              {[link.source_id, link.target_id].map((id) => {
                const b = bundles.find((b) => b.id === id);
                return (
                  b && (
                    <details key={id} className="bundle-members">
                      <summary>
                        {b.title} · {b.note_ids.length}개 메모
                      </summary>
                      <p className="preserve-text">{b.description}</p>
                      {b.note_ids.flatMap((id) => {
                        const n = noteMap.get(id);
                        return n
                          ? [
                              <details key={id}>
                                <summary>
                                  {n.title || n.content.slice(0, 40)}
                                </summary>
                                <p className="preserve-text">{n.content}</p>
                                <button
                                  type="button"
                                  onClick={() => onOpen("note", id)}
                                >
                                  메모 열기
                                </button>
                              </details>,
                            ]
                          : [];
                      })}
                    </details>
                  )
                );
              })}
            </form>
          )}
        </div>
      </div>
    </section>
  );
}
