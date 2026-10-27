"use client";
import { useEffect, useState } from "react";
import { usePagedResource } from "./use-paged-resource";
import { useLibraryCommand } from "./use-library-command";
export function NoteWhiteboardVisibility({
  noteId,
  disabled = false,
  preview = false,
}: {
  noteId: string;
  disabled?: boolean;
  preview?: boolean;
}) {
  const resource = usePagedResource<{ visible: boolean }>(
    `/api/whiteboard?view=visibility&noteId=${noteId}`,
    !preview,
  );
  const command = useLibraryCommand("/api/knowledge", resource.reload);
  const [choice, setChoice] = useState<boolean | null>(null);
  useEffect(() => {
    if (choice !== null && resource.data?.visible === choice) setChoice(null);
  }, [choice, resource.data]);
  const value = choice ?? resource.data?.visible;
  return (
    <div
      className="note-whiteboard-visibility"
      role="group"
      aria-label="화이트보드 표시"
    >
      <span>화이트보드</span>
      <div className="segmented-options">
        {(
          [
            [true, "보이기"],
            [false, "가리기"],
          ] as const
        ).map(([visible, label]) => (
          <button
            key={String(visible)}
            type="button"
            aria-pressed={value === visible}
            disabled={
              preview ||
              disabled ||
              command.busy ||
              typeof resource.data?.visible !== "boolean"
            }
            onClick={() => {
              setChoice(visible);
              void command.send("setWhiteboardNoteVisibility", {
                noteId,
                visible,
              });
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {resource.loading && !resource.data && (
        <small>표시 설정을 읽는 중…</small>
      )}
      {(resource.error || command.error) && (
        <p role="alert">
          {resource.error || command.error}
          <button type="button" onClick={resource.reload}>
            다시 조회
          </button>
        </p>
      )}
    </div>
  );
}
