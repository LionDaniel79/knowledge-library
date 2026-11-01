"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { WhiteboardSnapshot } from "@/lib/whiteboard";
import { usePagedResource } from "../use-paged-resource";
import { useLibraryCommand } from "../use-library-command";
import {
  LegacyThoughtReview,
  type LegacyThoughtReviewState,
} from "../whiteboard/legacy-thought-review";
export function ThoughtBoxes({
  revision,
  onOpen,
  enabled = true,
}: {
  revision?: unknown;
  onOpen: (kind: string, id: string) => void;
  enabled?: boolean;
}) {
  const inventory = usePagedResource<
    LegacyThoughtReviewState & {
      items: { id: string; title: string; noteCount: number }[];
      pendingLegacy?: boolean;
    }
  >("/api/thought-boxes", enabled, revision, { keepPreviousData: true });
  const resource = usePagedResource<WhiteboardSnapshot>(
    "/api/whiteboard",
    enabled,
    revision,
    { keepPreviousData: true },
  );
  const command = useLibraryCommand("/api/knowledge", () => {
    resource.reload();
    inventory.reload();
  });
  const [selected, setSelected] = useState(""),
    [drafts, setDrafts] = useState<
      Record<
        string,
        { title: string; description: string; version: number; dirty: boolean }
      >
    >({}),
    [message, setMessage] = useState("");
  const promoting = useRef(false);
  useEffect(() => {
    if (
      !enabled ||
      !inventory.data?.pendingLegacy ||
      inventory.data?.legacyConflicts?.length ||
      promoting.current
    )
      return;
    promoting.current = true;
    void command.send("promoteThoughtBoxes", {}).finally(() => {
      promoting.current = false;
    });
  }, [enabled, inventory.data]);
  const bundle = resource.data?.bundles?.find(
    (b) => b.id === selected && !b.archived_at,
  );
  useEffect(() => {
    if (!bundle) return;
    setDrafts((old) =>
      old[bundle.id]?.dirty
        ? old
        : {
            ...old,
            [bundle.id]: {
              title: bundle.title,
              description: bundle.description,
              version: bundle.version,
              dirty: false,
            },
          },
    );
  }, [bundle]);
  const draft = drafts[selected];
  const notes = useMemo(
    () =>
      bundle?.note_ids.map((id) =>
        resource.data?.notes.find((n) => n.id === id),
      ),
    [bundle, resource.data?.notes],
  );
  if (!enabled) return null;
  return (
    <section className="thought-box-workspace" aria-label="생각 묶음 관리">
      <div className="memo-box-toolbar">
        <button
          type="button"
          onClick={() => {
            inventory.reload();
            resource.reload();
          }}
        >
          목록 새로고침
        </button>
      </div>
      {(inventory.error || resource.error || command.error) && (
        <p role="alert">{inventory.error || resource.error || command.error}</p>
      )}
      <LegacyThoughtReview
        state={inventory.data}
        busy={command.busy}
        onMerge={(token) => {
          void command
            .send("promoteThoughtBoxes", { legacyToken: token })
            .then((result) => {
              if (!result) inventory.reload();
            });
        }}
      />
      {inventory.data?.pendingLegacy &&
        !inventory.data?.legacyConflicts?.length && (
          <p role="status">생각묶음 원본을 정리하는 중…</p>
        )}
      {message && <p role="status">{message}</p>}
      <div className="memo-box-columns">
        <div
          className="memo-box-list thought-box-list"
          aria-label="생각 묶음 목록"
        >
          {inventory.data?.items.map((box) => (
            <button
              type="button"
              key={box.id}
              aria-pressed={box.id === selected}
              className={box.id === selected ? "selected" : ""}
              onClick={() => {
                setSelected(box.id);
                setMessage("");
              }}
            >
              <span className="memo-group-title">{box.title}</span>
              <small>{box.noteCount}개 메모</small>
            </button>
          ))}
          {!inventory.loading && !inventory.data?.items.length && (
            <p>보드에서 상자를 만들면 여기에 표시됩니다.</p>
          )}
        </div>
        <div className="panel memo-box-detail thought-box-editor">
          {!selected ? (
            <p>생각묶음을 선택하면 원문과 정리를 볼 수 있습니다.</p>
          ) : draft && bundle ? (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const result = await command.send("saveMemoBundle", {
                  id: bundle.id,
                  expectedVersion: draft.version,
                  title: draft.title,
                  description: draft.description,
                  noteIds: bundle.note_ids,
                });
                if (result) {
                  setDrafts((old) => ({
                    ...old,
                    [bundle.id]: {
                      ...draft,
                      version: result.version,
                      dirty: false,
                    },
                  }));
                  setMessage("원본을 저장했습니다.");
                }
              }}
            >
              <fieldset
                disabled={command.busy || inventory.data?.pendingLegacy}
              >
                <label>
                  제목
                  <input
                    aria-label="생각묶음 제목"
                    maxLength={300}
                    value={draft.title}
                    onChange={(e) =>
                      setDrafts((old) => ({
                        ...old,
                        [selected]: {
                          ...draft,
                          title: e.target.value,
                          dirty: true,
                        },
                      }))
                    }
                  />
                </label>
                <label>
                  내용
                  <textarea
                    rows={5}
                    maxLength={20000}
                    value={draft.description}
                    onChange={(e) =>
                      setDrafts((old) => ({
                        ...old,
                        [selected]: {
                          ...draft,
                          description: e.target.value,
                          dirty: true,
                        },
                      }))
                    }
                  />
                </label>
                {draft.dirty && draft.version !== bundle.version && (
                  <div className="notice">
                    <p>
                      다른 곳에서 원본이 변경되었습니다. 입력한 내용은
                      유지됩니다.
                    </p>
                    <details>
                      <summary>최신 원본 확인</summary>
                      <p>{bundle.title}</p>
                      <p className="preserve-text">{bundle.description}</p>
                    </details>
                    <button
                      type="button"
                      onClick={() =>
                        setDrafts((old) => ({
                          ...old,
                          [selected]: { ...draft, version: bundle.version },
                        }))
                      }
                    >
                      최신 원본을 확인하고 내 입력 유지
                    </button>
                  </div>
                )}
                {(notes ?? []).map((note, index) => (
                  <article
                    className="thought-box-note"
                    key={bundle.note_ids[index]}
                  >
                    <button
                      type="button"
                      disabled={!note}
                      onClick={() => onOpen("note", bundle.note_ids[index])}
                    >
                      {note?.title || "메모"}
                    </button>
                    <p className="preserve-text">
                      {note?.content || "원본 메모를 확인할 수 없습니다."}
                    </p>
                  </article>
                ))}
                <div className="form-footer">
                  <button
                    type="button"
                    onClick={async () => {
                      if (
                        !window.confirm(
                          `‘${bundle.title}’ 생각묶음을 삭제할까요? 메모 원문은 유지됩니다.`,
                        )
                      )
                        return;
                      const result = await command.send("archiveMemoBundle", {
                        id: bundle.id,
                        expectedVersion: bundle.version,
                      });
                      if (!result) return;
                      setSelected("");
                      setDrafts((old) => {
                        const next = { ...old };
                        delete next[bundle.id];
                        return next;
                      });
                      setMessage(
                        "생각묶음을 삭제했습니다. 원문 메모는 유지됩니다.",
                      );
                    }}
                  >
                    삭제
                  </button>
                  <button
                    className="primary"
                    disabled={
                      !draft.dirty ||
                      !draft.title.trim() ||
                      draft.version !== bundle.version
                    }
                  >
                    원본 저장
                  </button>
                </div>
              </fieldset>
            </form>
          ) : (
            <p role="status">원본을 여는 중…</p>
          )}
        </div>
      </div>
    </section>
  );
}
