"use client";
import { useRef, useState } from "react";
import type { Command, Library, Note } from "@/lib/domain";
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
  const [emptyPending, setEmptyPending] = useState<{
    requestId: string;
    notes: { id: string; expectedVersion: number }[];
  } | null>(null);
  const notes = library.deletedNotes ?? [];
  async function emptyTrash() {
    if (!emptyPending || busy) return;
    setBusy(true);
    setError("");
    try {
      await onSave({
        type: "emptyNoteTrash",
        requestId: emptyPending.requestId,
        payload: { notes: emptyPending.notes },
      });
      setEmptyPending(null);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "휴지통을 비우지 못했습니다.",
      );
    } finally {
      setBusy(false);
    }
  }
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
      {notes.length > 0 && (
        <button
          type="button"
          className="secondary danger"
          disabled={busy}
          onClick={() =>
            setEmptyPending({
              requestId: crypto.randomUUID(),
              notes: notes.map((n) => ({
                id: n.id,
                expectedVersion: n.version,
              })),
            })
          }
        >
          전체삭제
        </button>
      )}
      {emptyPending && (
        <div
          role="group"
          aria-label="휴지통 전체삭제 확인"
          className="trash-confirm"
        >
          <p>
            휴지통의 기록 {emptyPending.notes.length}개와 현재 서재의 수정
            이력·관련 연결을 영구 삭제합니다. 연구 묶음에 담긴 해당 기록도
            삭제됩니다. 복원할 수 없습니다.
          </p>
          <p>이전에 가져온 원본 자료와 기존 백업은 유지됩니다.</p>
          <button
            type="button"
            className="secondary danger"
            disabled={busy}
            onClick={() => void emptyTrash()}
          >
            영구 삭제
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => setEmptyPending(null)}
          >
            취소
          </button>
        </div>
      )}
      {notes.map((n) => (
        <article key={n.id}>
          <h3>{n.title}</h3>
          <p>{n.deletedAt.slice(0, 10)} 삭제</p>
          <details>
            <summary>내용 보기</summary>
            {n.summary ? (
              <TrashBody id={n.id} />
            ) : (
              <p className="quote">{n.content}</p>
            )}
          </details>
          <button disabled={busy} onClick={() => void restore(n.id, n.version)}>
            복원
          </button>
        </article>
      ))}
    </details>
  );
}

function TrashBody({ id }: { id: string }) {
  const [body, setBody] = useState("");
  return (
    <>
      <button
        onClick={async () => {
          try {
            const r = await fetch(`/api/notes/${id}?trash=true`, {
                cache: "no-store",
              }),
              j = await r.json();
            setBody(r.ok ? j.content : j.error);
          } catch {
            setBody("내용을 불러오지 못했습니다.");
          }
        }}
      >
        원문 불러오기
      </button>
      <p className="quote">{body}</p>
    </>
  );
}
