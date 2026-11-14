"use client";
import { useEffect, useState } from "react";
import type { Library } from "@/lib/domain";
import type { connectedMemoGroups } from "@/lib/memo-box";
import { AssistLauncher } from "../assist-panel";
type Group = ReturnType<typeof connectedMemoGroups>[number];

export function MemoGroupEditor({
  group,
  library,
  boardVersion,
  busy,
  onCommit,
  onUpdated,
}: {
  group: Group;
  library: Library;
  boardVersion: number;
  busy: boolean;
  onCommit: (payload: unknown) => Promise<unknown>;
  onUpdated: () => void;
}) {
  const makeDraft = () => ({
    expectedBoardVersion: boardVersion,
    children: group.children ?? group.connections.map((c) => [c.id]),
    title: group.title || group.connections[0]?.title || "",
    reason:
      group.reason ??
      (group.connections.length === 1 ? group.connections[0].reason : ""),
    connections: group.connections.map((c) => ({
      id: c.id,
      expectedVersion: c.version,
      title: c.title ?? "",
      reason: c.reason,
    })),
  });
  const [draft, setDraft] = useState(makeDraft),
    [dirty, setDirty] = useState(false),
    [waiting, setWaiting] = useState(0);
  useEffect(() => {
    if (!dirty && boardVersion >= waiting) {
      setDraft(makeDraft());
      setWaiting(0);
    }
  }, [group, boardVersion, dirty, waiting]);
  const edit = (patch: Partial<typeof draft>) => {
    setDraft((old) => ({ ...old, ...patch }));
    setDirty(true);
  };
  const aggregate = group.connections.length > 1;
  const conflict =
    draft.expectedBoardVersion !== boardVersion ||
    group.connections.some(
      (c) =>
        draft.connections.find((d) => d.id === c.id)?.expectedVersion !==
        c.version,
    );
  const notes = new Map(group.notes.map((n) => [n.id, n]));
  return (
    <div className="memo-group-editor">
      {group.notes.map((n) => (
        <article key={n.id} className="memo-group-note">
          <h3>{n.title || "메모"}</h3>
          <p className="preserve-text">{n.content}</p>
        </article>
      ))}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const result = (await onCommit({ ...draft, split: false })) as {
            version?: number;
          } | null;
          if (result) {
            setWaiting(result.version ?? 0);
            setDirty(false);
          }
        }}
      >
        <fieldset disabled={busy}>
          <section
            className={
              aggregate ? "memo-aggregate-fields" : "memo-connection-fields"
            }
            aria-label={aggregate ? "전체 연결" : "메모 연결"}
          >
            <label>
              {aggregate ? "전체 연결 제목" : "연결 제목"}
              <input
                value={draft.title}
                maxLength={300}
                onChange={(e) => edit({ title: e.target.value })}
              />
            </label>
            {!aggregate && (
              <strong className="memo-connection-members">
                {group.notes.map((n) => n.title || "메모").join(" ↔ ")}
              </strong>
            )}
            <label>
              {aggregate ? "전체 연결 이유" : "연결 이유"}
              <textarea
                rows={3}
                value={draft.reason}
                maxLength={2000}
                onChange={(e) => edit({ reason: e.target.value })}
              />
            </label>
          </section>
          {aggregate &&
            draft.connections.map((c) => {
              const source = group.connections.find(
                (edge) => edge.id === c.id,
              )!;
              const change = (patch: Partial<typeof c>) =>
                edit({
                  connections: draft.connections.map((old) =>
                    old.id === c.id ? { ...old, ...patch } : old,
                  ),
                });
              return (
                <section
                  key={c.id}
                  className="memo-connection-fields"
                  aria-label="개별 메모 연결"
                >
                  <label>
                    연결 제목
                    <input
                      maxLength={300}
                      value={c.title}
                      onChange={(e) => change({ title: e.target.value })}
                    />
                  </label>
                  <strong className="memo-connection-members">
                    {notes.get(source.source_id)?.title || "메모"} ↔{" "}
                    {notes.get(source.target_id)?.title || "메모"}
                  </strong>
                  <label>
                    연결 이유
                    <textarea
                      rows={3}
                      maxLength={2000}
                      value={c.reason}
                      onChange={(e) => change({ reason: e.target.value })}
                    />
                  </label>
                </section>
              );
            })}
          {conflict && (
            <section className="notice">
              <p role="alert">
                다른 곳에서 연결이 변경되었습니다. 입력은 유지됩니다.
              </p>
              <details>
                <summary>최신 연결 확인</summary>
                <p>{group.title}</p>
                <p>{group.reason}</p>
                {group.connections.map((c) => (
                  <p key={c.id}>
                    {c.title} · {c.reason}
                  </p>
                ))}
              </details>
              <button
                type="button"
                onClick={() =>
                  setDraft((old) => ({
                    ...makeDraft(),
                    title: old.title,
                    reason: old.reason,
                    connections: makeDraft().connections.map((c) => ({
                      ...c,
                      ...(old.connections.find((v) => v.id === c.id)
                        ? {
                            title: old.connections.find((v) => v.id === c.id)!
                              .title,
                            reason: old.connections.find((v) => v.id === c.id)!
                              .reason,
                          }
                        : {}),
                    })),
                  }))
                }
              >
                최신 연결을 확인하고 입력 유지
              </button>
            </section>
          )}
          <div className="form-footer">
            <button className="primary" disabled={!dirty || conflict}>
              수정 저장
            </button>
            <button
              type="button"
              disabled={conflict}
              onClick={async () => {
                if (
                  !window.confirm(
                    aggregate
                      ? "최상위 결합을 해제하고 개별 연결된 메모로 나눌까요? 각 메모와 개별 연결은 유지됩니다."
                      : "두 메모의 연결을 끊을까요? 메모 원문은 유지됩니다.",
                  )
                )
                  return;
                await onCommit({ ...makeDraft(), split: true });
              }}
            >
              연결 끊기
            </button>
          </div>
        </fieldset>
      </form>
      <AssistLauncher
        key={group.id}
        library={{ ...library, notes: group.notes }}
        onAdopt={onUpdated}
        editorAnalysis={{
          context: {
            kind: "connection",
            id: group.connections
              .map((c) => c.id)
              .sort()
              .join(","),
            noteIds: group.notes.map((n) => n.id),
          },
          notes: group.notes,
          onApply: (s) => edit({ title: s.title, reason: s.reason }),
        }}
      />
    </div>
  );
}
