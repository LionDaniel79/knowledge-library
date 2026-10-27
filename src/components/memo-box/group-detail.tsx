"use client";
import type { connectedMemoGroups } from "@/lib/memo-box";
import type { NewNoteContext } from "@/lib/note-context";
import { ConnectionEditor } from "./connection-editor";
import { relationNames, type Relation } from "@/lib/knowledge";
type Group = ReturnType<typeof connectedMemoGroups>[number];
export function MemoGroupDetail({
  group,
  onOpen,
  onNewNote,
  topicIdsForNote,
  busy,
  onSave,
  onRemove,
  compact = false,
}: {
  group: Group;
  onOpen: (kind: string, id: string) => void;
  onNewNote?: (context: NewNoteContext) => void;
  topicIdsForNote?: (id: string) => string[] | undefined;
  busy: boolean;
  onSave: (p: unknown) => Promise<{ version?: number } | null>;
  onRemove?: (c: Group["connections"][number]) => void;
  compact?: boolean;
}) {
  const notes = new Map(group.notes.map((n) => [n.id, n]));
  return (
    <div className={`memo-group-detail${compact ? " memo-group-compact" : ""}`}>
      {group.notes.map((n) => {
        const title =
          n.title === "미분류 메모"
            ? n.content.slice(0, 60)
            : n.title || "메모";
        const body = (
          <>
            <p className="preserve-text">{n.content}</p>
            <div className="form-footer">
              <button type="button" onClick={() => onOpen("note", n.id)}>
                메모 수정·분류
              </button>
              {onNewNote && (
                <button
                  type="button"
                  onClick={() =>
                    onNewNote({
                      relatedNotes: [{ id: n.id, title: n.title }],
                      topicIds: topicIdsForNote?.(n.id),
                    })
                  }
                >
                  관련 기록 남기기
                </button>
              )}
            </div>
          </>
        );
        return compact ? (
          <details className="memo-group-note" key={n.id}>
            <summary>{title}</summary>
            {body}
          </details>
        ) : (
          <article className="memo-group-note" key={n.id}>
            <h3>{title}</h3>
            {body}
          </article>
        );
      })}
      {group.connections.map((c) => {
        const title = (
          <>
            {notes.get(c.source_id)?.title || "메모"} ↔{" "}
            {notes.get(c.target_id)?.title || "메모"}
          </>
        );
        const body = (
          <>
            <ConnectionEditor
              key={c.id}
              connection={c}
              busy={busy}
              onSave={onSave}
            />
            {onRemove && (
              <button type="button" disabled={busy} onClick={() => onRemove(c)}>
                연결 끊기
              </button>
            )}
          </>
        );
        return compact ? (
          <details className="memo-box-edge" key={c.id}>
            <summary>
              {title}
              <small>{relationNames[c.relation as Relation] ?? "관련"}</small>
            </summary>
            {body}
          </details>
        ) : (
          <article className="memo-box-edge" key={c.id}>
            <h4>{title}</h4>
            {body}
          </article>
        );
      })}
    </div>
  );
}
