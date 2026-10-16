"use client";
import { useRef, useState } from "react";
import type { Command, Library } from "@/lib/domain";
export function NoteTrash({
  library,
  onSave,
}: {
  library: Library;
  onSave: (c: Command) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const pending = useRef<{ key: string; id: string } | null>(null);
  const notes = library.deletedNotes ?? [];
  async function restore(id: string, version: number) {
    if (busy) return;
    const key = id + ":" + version;
    if (pending.current?.key !== key)
      pending.current = { key, id: crypto.randomUUID() };
    setBusy(true);
    setError("");
    try {
      await onSave({
        type: "restoreNote",
        requestId: pending.current.id,
        payload: { id, expectedVersion: version },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "복원하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="panel note-trash">
      <summary>휴지통 · {notes.length}개</summary>
      {error && <p role="alert">{error}</p>}
      {!notes.length && <p>삭제한 기록이 없습니다.</p>}
      {notes.map((n) => (
        <article key={n.id}>
          <h3>{n.title}</h3>
          <p>{n.deletedAt.slice(0, 10)} 삭제</p>
          <details>
            <summary>내용 보기</summary>
            <p className="quote">{n.content}</p>
          </details>
          <button disabled={busy} onClick={() => void restore(n.id, n.version)}>
            복원
          </button>
        </article>
      ))}
    </details>
  );
}
