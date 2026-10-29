"use client";
import { useEffect, useMemo, useState } from "react";
import type { ThoughtBoxSummary } from "@/lib/thought-boxes";
import { boxNotes } from "@/lib/thought-boxes";
import type { Board, WhiteboardSnapshot } from "@/lib/whiteboard";
import type { WritingChapter } from "@/lib/writing-board";
import { usePagedResource } from "../use-paged-resource";
import { useLibraryCommand } from "../use-library-command";

type BoardDraft = {
  source: WhiteboardSnapshot;
  base: Board;
  data: Board;
  expectedVersion: number;
  latestVersion: number;
  dirty: boolean;
};

export function ThoughtBoxes({
  enabled = true,
  revision,
  onOpen,
}: {
  enabled?: boolean;
  revision?: unknown;
  onOpen: (kind: string, id: string) => void;
}) {
  const inventory = usePagedResource<{ items: ThoughtBoxSummary[] }>(
    "/api/thought-boxes",
    enabled,
    revision,
    { keepPreviousData: true },
  );
  const [selected, setSelected] = useState<ThoughtBoxSummary | null>(null);
  const [drafts, setDrafts] = useState<Record<string, BoardDraft>>({});
  const [message, setMessage] = useState("");
  const [saveError, setSaveError] = useState("");
  const [dismissedCommandError, setDismissedCommandError] = useState("");
  const resource = usePagedResource<WhiteboardSnapshot>(
    selected ? `/api/whiteboard?boardId=${selected.boardId}` : "",
    enabled && !!selected,
    revision,
    { keepPreviousData: true },
  );
  const command = useLibraryCommand("/api/knowledge", () => {
    inventory.reload();
    resource.reload();
  });

  useEffect(() => {
    const source = resource.data;
    const board = source?.board;
    if (!source || !board || board.id !== selected?.boardId) return;
    setDrafts((previous) => {
      const old = previous[board.id];
      if (old && board.version < old.expectedVersion) return previous;
      return {
        ...previous,
        [board.id]: old?.dirty
          ? { ...old, source, latestVersion: board.version }
          : {
              source,
              base: board.data,
              data: board.data,
              expectedVersion: board.version,
              latestVersion: board.version,
              dirty: false,
            },
      };
    });
  }, [resource.data, selected?.boardId]);

  const draft = selected ? drafts[selected.boardId] : undefined;
  const chapter = draft?.data.writing?.chapters.find(
    (box) => box.id === selected?.chapterId,
  );
  const notes = useMemo(
    () => (chapter && draft ? boxNotes(chapter, draft.source) : []),
    [chapter, draft?.source],
  );
  const stale = draft && draft.latestVersion !== draft.expectedVersion;
  const missing =
    selected &&
    resource.data &&
    (!resource.data.board ||
      resource.data.board.id !== selected.boardId ||
      !chapter);
  const error =
    resource.error ||
    inventory.error ||
    saveError ||
    (command.error !== dismissedCommandError ? command.error : "") ||
    (missing
      ? "원래 상자를 찾을 수 없습니다. 작성 중인 내용은 유지됩니다."
      : "");

  function editChapter(
    update: (box: WritingChapter, source: WhiteboardSnapshot) => WritingChapter,
  ) {
    if (!selected) return;
    setMessage("");
    setDrafts((previous) => {
      const current = previous[selected.boardId];
      if (!current?.data.writing) return previous;
      return {
        ...previous,
        [selected.boardId]: {
          ...current,
          dirty: true,
          data: {
            ...current.data,
            writing: {
              ...current.data.writing,
              chapters: current.data.writing.chapters.map((box) =>
                box.id === selected.chapterId
                  ? update(box, current.source)
                  : box,
              ),
            },
          },
        },
      };
    });
  }

  function mergeLatest() {
    const latest = draft?.source.board;
    if (!selected || !draft || !chapter || !latest) return;
    setSaveError("");
    setDismissedCommandError(command.error);
    if (!latest.data.writing) {
      setSaveError(
        "원래 상자가 최신 보드에서 삭제되었습니다. 작성 중인 내용은 유지됩니다.",
      );
      return;
    }
    const updates = new Map<string, WritingChapter>();
    for (const edited of draft.data.writing?.chapters ?? []) {
      const original = draft.base.writing?.chapters.find(
        (box) => box.id === edited.id,
      );
      if (!original) continue;
      const baseOrders = new Map(
        boxNotes(original, draft.source).map((item) => [
          item.noteIds[0],
          item.order,
        ]),
      );
      const changedOrders = new Map(
        boxNotes(edited, draft.source)
          .filter((item) => baseOrders.get(item.noteIds[0]) !== item.order)
          .map((item) => [item.noteIds[0], item.order]),
      );
      if (
        edited.title === original.title &&
        edited.text === original.text &&
        edited.order === original.order &&
        !changedOrders.size
      )
        continue;
      const destination = latest.data.writing.chapters.find(
        (box) => box.id === edited.id,
      );
      if (!destination) {
        setSaveError(
          "원래 상자가 최신 보드에서 삭제되었습니다. 작성 중인 내용은 유지됩니다.",
        );
        return;
      }
      const latestItems = boxNotes(destination, draft.source);
      if (
        [...changedOrders.keys()].some(
          (id) => !latestItems.some((item) => item.noteIds[0] === id),
        )
      ) {
        setSaveError(
          "순서를 바꾼 메모가 최신 상자에서 빠졌습니다. 작성 중인 내용은 유지됩니다.",
        );
        return;
      }
      updates.set(edited.id, {
        ...destination,
        ...(edited.title !== original.title ? { title: edited.title } : {}),
        ...(edited.text !== original.text ? { text: edited.text } : {}),
        ...(edited.order !== original.order ? { order: edited.order } : {}),
        ...(changedOrders.size
          ? {
              items: latestItems.map((item) =>
                changedOrders.has(item.noteIds[0])
                  ? { ...item, order: changedOrders.get(item.noteIds[0])! }
                  : item,
              ),
            }
          : {}),
      });
    }
    setDrafts((previous) => ({
      ...previous,
      [selected.boardId]: {
        ...draft,
        base: latest.data,
        data: {
          ...latest.data,
          writing: {
            ...latest.data.writing!,
            chapters: latest.data.writing!.chapters.map(
              (box) => updates.get(box.id) ?? box,
            ),
          },
        },
        expectedVersion: latest.version,
        latestVersion: latest.version,
        dirty: true,
      },
    }));
    setMessage(
      "내 변경을 최신 보드에 합쳤습니다. 내용을 확인하고 저장해 주세요.",
    );
  }

  async function save() {
    if (!selected || !draft?.dirty || command.busy) return;
    const boardId = selected.boardId;
    const submitted = draft;
    setSaveError("");
    setDismissedCommandError("");
    setMessage("");
    const result = await command.send("saveWhiteboard", {
      boardId,
      data: submitted.data,
      expectedVersion: submitted.expectedVersion,
    });
    if (!result) {
      resource.reload();
      inventory.reload();
      return;
    }
    if (!Number.isInteger(result.version) || result.version < 0) {
      setSaveError(
        "저장 상태를 확인하지 못했습니다. 작성 중인 내용은 유지됩니다.",
      );
      return;
    }
    setDrafts((previous) => ({
      ...previous,
      [boardId]: {
        ...submitted,
        base: submitted.data,
        expectedVersion: result.version,
        latestVersion: result.version,
        dirty: false,
      },
    }));
    setMessage(
      result.queued
        ? "상자 변경을 기기에 저장했습니다."
        : "상자 변경을 저장했습니다.",
    );
  }

  if (!enabled) return null;

  return (
    <section className="thought-box-workspace" aria-label="생각 묶음 관리">
      <div className="memo-box-toolbar">
        <button
          type="button"
          disabled={command.busy}
          onClick={() => {
            inventory.reload();
            resource.reload();
          }}
        >
          목록 새로고침
        </button>
      </div>
      {(error || stale) && (
        <p role="alert">
          {error ||
            "다른 곳에서 상자가 변경되었습니다. 작성 중인 내용은 유지됩니다."}
        </p>
      )}
      {stale && (
        <button
          type="button"
          disabled={command.busy || resource.loading}
          onClick={mergeLatest}
        >
          내 변경을 최신 보드에 합치기
        </button>
      )}
      {message && <p role="status">{message}</p>}
      <div className="memo-box-columns">
        <div
          className="memo-box-list thought-box-list"
          aria-label="생각 묶음 목록"
        >
          {inventory.data?.items.map((box) => (
            <button
              key={box.id}
              type="button"
              disabled={command.busy}
              aria-pressed={selected?.id === box.id}
              className={selected?.id === box.id ? "selected" : ""}
              onClick={() => {
                setSelected(box);
                setMessage("");
                setSaveError("");
              }}
            >
              <small>{box.boardTitle}</small>
              <span className="memo-group-title">
                {box.order}. {box.title || "제목 없는 상자"}
              </span>
              <small>{box.noteCount}개 메모</small>
            </button>
          ))}
          {inventory.loading && !inventory.data && (
            <p role="status">생각 묶음을 여는 중…</p>
          )}
          {!inventory.loading && inventory.data?.items.length === 0 && (
            <p>보드에서 메모를 담은 상자를 만들면 여기에 표시됩니다.</p>
          )}
        </div>
        <div className="panel memo-box-detail thought-box-editor">
          {!selected ? (
            <p>생각 묶음을 선택하면 원문과 정리를 볼 수 있습니다.</p>
          ) : !draft || !chapter ? (
            resource.loading ? (
              <p role="status">상자를 여는 중…</p>
            ) : null
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <p>{selected.boardTitle}에 있는 상자입니다.</p>
              <fieldset disabled={command.busy}>
                <label>
                  상자 번호
                  <input
                    type="number"
                    min={1}
                    max={100000}
                    required
                    value={chapter.order}
                    onChange={(event) =>
                      editChapter((box) => ({
                        ...box,
                        order: Number(event.target.value),
                      }))
                    }
                  />
                </label>
                <label>
                  상자 제목
                  <input
                    maxLength={300}
                    value={chapter.title}
                    onChange={(event) =>
                      editChapter((box) => ({
                        ...box,
                        title: event.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  상자 내용
                  <textarea
                    aria-label="상자 내용"
                    rows={5}
                    maxLength={20000}
                    value={chapter.text}
                    onChange={(event) =>
                      editChapter((box) => ({
                        ...box,
                        text: event.target.value,
                      }))
                    }
                  />
                </label>
                {[...notes]
                  .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
                  .map((item) => {
                    const id = item.noteIds[0];
                    const note = draft.source.notes.find(
                      (note) => note.id === id,
                    );
                    const title = note?.title || item.label || "메모";
                    return (
                      <article key={item.id} className="thought-box-note">
                        <label>
                          메모 순서
                          <input
                            type="number"
                            aria-label={`${title} 순서`}
                            min={1}
                            max={100000}
                            required
                            value={item.order}
                            onChange={(event) => {
                              const order = Number(event.target.value);
                              editChapter((box, source) => ({
                                ...box,
                                items: (box.items.some(
                                  (old) =>
                                    old.id === item.id &&
                                    old.noteIds.length === 1,
                                )
                                  ? box.items
                                  : boxNotes(box, source)
                                ).map((old) =>
                                  old.id === item.id ? { ...old, order } : old,
                                ),
                              }));
                            }}
                          />
                        </label>
                        <button
                          type="button"
                          disabled={!note}
                          aria-label={`${title} 원본 메모 열기`}
                          onClick={() => onOpen("note", id)}
                        >
                          {title}
                        </button>
                        <p className="preserve-text">
                          {note?.content ||
                            "삭제되었거나 확인할 수 없는 메모입니다."}
                        </p>
                      </article>
                    );
                  })}
                {!notes.length && <p>이 상자에 담긴 메모가 없습니다.</p>}
                <div className="form-footer">
                  <button
                    className="primary"
                    disabled={!draft.dirty || command.busy}
                  >
                    {command.busy ? "저장 중…" : "상자 변경 저장"}
                  </button>
                </div>
              </fieldset>
            </form>
          )}
        </div>
      </div>
    </section>
  );
}
