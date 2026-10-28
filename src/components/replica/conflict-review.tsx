"use client";
import { useEffect, useMemo, useState } from "react";
import { useReplicaOptional } from "./provider";
import { Modal } from "../modal";
import { ConflictChoice } from "./conflict-choice";
import {
  loadReplicaConflict,
  readConflictContext,
  applyReplicaResolution,
  type ConflictReview,
  type Resolution,
} from "@/client/replica/conflicts";
import {
  describeQueuedConflict,
  presentConflict,
  type ConflictContext,
} from "@/lib/replica/conflict-presentation";
import type { OutboxEntry } from "@/lib/replica/contracts";
import type { QueuedChange } from "@/client/replica/optimistic";

const emptyContext: ConflictContext = {
  bookTitles: {},
  topicNames: {},
  sourceTitles: {},
};
const originalText = (value: unknown) =>
  value == null ? "자료 없음" : JSON.stringify(value, null, 2);
export function ConflictReviewPanel() {
  const replica = useReplicaOptional(),
    [entries, setEntries] = useState<OutboxEntry[]>([]),
    [context, setContext] = useState<ConflictContext>(emptyContext),
    [review, setReview] = useState<ConflictReview | null>(null),
    [drafts, setDrafts] = useState<
      Record<string, { title: string; content: string }>
    >({}),
    [choices, setChoices] = useState<
      Record<string, { choice: Resolution["choice"]; token: string }>
    >({}),
    [advanced, setAdvanced] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  useEffect(() => {
    let live = true;
    if (replica?.ready)
      void (async () => {
        try {
          const rows = (await replica.runtime.storage.listOutbox()).filter(
            (e) => e.state === "conflict" || e.state === "failed",
          );
          if (live) setEntries(rows);
          const titles = await readConflictContext(
            replica.runtime.storage,
            rows,
          );
          if (live) setContext(titles);
        } catch (e) {
          if (live) setError((e as Error).message);
        }
      })();
    return () => {
      live = false;
    };
  }, [
    replica?.ready,
    replica?.revision,
    replica?.status.conflicts,
    replica?.status.failed,
    replica?.runtime,
  ]);
  const presentation = useMemo(
    () => (review ? presentConflict(review) : null),
    [review],
  );
  if (!replica?.ready) return null;
  const runtime = replica.runtime;
  async function open(id: string) {
    setBusy(true);
    setError("");
    setAdvanced(false);
    setNotice("");
    try {
      const r = await loadReplicaConflict(runtime.storage, id);
      const draftId = r.firstEntry.requestId;
      setReview(r);
      setDrafts((d) =>
        d[draftId]
          ? d
          : {
              ...d,
              [draftId]: {
                title: r.local?.title ?? "",
                content: r.local?.content ?? "",
              },
            },
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function resolve(choice: Resolution["choice"]) {
    if (!review || busy) return;
    setBusy(true);
    setError("");
    try {
      await applyReplicaResolution(runtime.storage, review, {
        choice,
        ...(choice === "mine" && review.deletedTopic
          ? { restoreTopic: true }
          : {}),
        ...(["merge", "copy"].includes(choice)
          ? { text: drafts[review.firstEntry.requestId] }
          : {}),
      });
      await runtime.notifyLocalChange();
      setReview(null);
      setNotice("선택한 내용을 반영했습니다.");
      void runtime.sync({ reason: "local-save" }).catch(() => {});
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const savedChoice = review ? choices[review.firstEntry.requestId] : undefined,
    selected =
      savedChoice?.token === review?.token ? savedChoice?.choice : null,
    draft = review ? drafts[review.firstEntry.requestId] : null,
    isNote = presentation?.canEditNote ?? false;
  function choose(choice: Resolution["choice"]) {
    if (review && !busy)
      setChoices((old) => ({
        ...old,
        [review.firstEntry.requestId]: { choice, token: review.token },
      }));
  }
  return (
    <>
      {!!entries.length && (
        <details className="panel sync-issues">
          <summary>동기화 확인 · {entries.length}개</summary>
          <div className="sync-issue-list">
            {entries.map((e) => {
              const item = describeQueuedConflict(e, context);
              return (
                <button
                  type="button"
                  className="sync-issue-card"
                  aria-label={`검토 ${item.title}`}
                  key={e.requestId}
                  disabled={busy}
                  onClick={() => void open(e.requestId)}
                >
                  <span className="sync-issue-operation">{item.operation}</span>
                  <strong>{item.title}</strong>
                  <span className="sync-issue-detail">{item.detail}</span>
                  <span className="sync-issue-next" aria-hidden="true">
                    내용 선택 ›
                  </span>
                </button>
              );
            })}
          </div>
        </details>
      )}
      {notice && (
        <p role="status" className="sync-resolution-notice">
          {notice}
        </p>
      )}
      {error && !review && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {review && presentation && (
        <Modal
          className="sync-review-modal"
          title="동기화 내용 선택"
          canClose={!busy}
          onClose={() => {
            if (!busy) setReview(null);
          }}
        >
          <div className="conflict-review">
            <div className="sync-review-heading">
              <span>{presentation.operation}</span>
              <h3>{presentation.title}</h3>
              <p>
                {presentation.changed.length
                  ? `달라진 항목: ${presentation.changed.join(" · ")}`
                  : "표시된 내용은 같지만 저장 이력이 달라 확인이 필요합니다."}
              </p>
            </div>
            <div
              className="sync-choice-grid"
              role="radiogroup"
              aria-label="반영할 내용 선택"
            >
              <ConflictChoice
                name="서버 내용 선택"
                title="온라인 서재"
                description={
                  review.deletedTopic
                    ? "주제 삭제 상태 유지 · 메모 보존"
                    : "서버에 저장된 최신 내용"
                }
                preview={presentation.server}
                selected={selected === "server"}
                disabled={busy}
                onSelect={() => choose("server")}
              />
              <ConflictChoice
                name="PC 내용 선택"
                title="이 PC"
                description={
                  review.deletedTopic
                    ? `‘${review.deletedTopic.name}’ 주제를 복원하고 분류 적용`
                    : "이 기기에 보관한 수정 내용"
                }
                preview={presentation.pc}
                selected={selected === "mine"}
                disabled={busy || !!review.unavailable}
                onSelect={() => choose("mine")}
              />
              {isNote && (
                <div className="sync-note-options">
                  <label
                    className={
                      selected === "merge"
                        ? "sync-extra-choice selected"
                        : "sync-extra-choice"
                    }
                  >
                    <input
                      type="radio"
                      name="sync-content-choice"
                      aria-label="직접 수정"
                      checked={selected === "merge"}
                      disabled={busy || !!review.unavailable}
                      onChange={() => choose("merge")}
                    />
                    <span>직접 수정</span>
                  </label>
                  <label
                    className={
                      selected === "copy"
                        ? "sync-extra-choice selected"
                        : "sync-extra-choice"
                    }
                  >
                    <input
                      type="radio"
                      name="sync-content-choice"
                      aria-label="새 기록으로 보관"
                      checked={selected === "copy"}
                      disabled={busy}
                      onChange={() => choose("copy")}
                    />
                    <span>새 기록으로 보관</span>
                  </label>
                </div>
              )}
            </div>
            {review.unavailable && (
              <p role="status" className="notice">
                {review.unavailable}
              </p>
            )}
            {review.deletedTopic && !review.unavailable && (
              <p className="notice" role="status">
                삭제된 주제:{" "}
                {review.topicsToRestore.map((t) => t.name).join(" · ")}. 이 PC를
                선택하면 주제를 복원한 뒤 분류합니다.
              </p>
            )}
            {isNote &&
              draft &&
              (selected === "merge" || selected === "copy") && (
                <section className="sync-merge-editor">
                  <label>
                    선택할 제목
                    <input
                      value={draft.title}
                      disabled={busy}
                      maxLength={300}
                      onChange={(e) =>
                        setDrafts((d) => ({
                          ...d,
                          [review.firstEntry.requestId]: {
                            ...draft,
                            title: e.target.value,
                          },
                        }))
                      }
                    />
                  </label>
                  <label>
                    선택할 내용
                    <textarea
                      rows={7}
                      value={draft.content}
                      disabled={busy}
                      maxLength={50000}
                      onChange={(e) =>
                        setDrafts((d) => ({
                          ...d,
                          [review.firstEntry.requestId]: {
                            ...draft,
                            content: e.target.value,
                          },
                        }))
                      }
                    />
                  </label>
                </section>
              )}
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <div className="sync-review-actions">
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await runtime.sync({ reason: "conflict-refresh" });
                    await open(review.firstEntry.requestId);
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                최신 내용 확인
              </button>
              <button
                type="button"
                className="primary"
                disabled={
                  busy ||
                  !selected ||
                  ((selected === "mine" || selected === "merge") &&
                    !!review.unavailable)
                }
                onClick={() => {
                  if (selected) void resolve(selected);
                }}
              >
                {busy
                  ? "반영 중…"
                  : selected === "mine" && review.deletedTopic
                    ? "주제 복원 후 적용"
                    : "선택한 내용 적용"}
              </button>
            </div>
            <small className="sync-archive-hint">
              선택 전 입력도 이 기기에 보관합니다.
            </small>
            <details
              className="sync-review-originals"
              onToggle={(e) => {
                if (e.target === e.currentTarget)
                  setAdvanced(e.currentTarget.open);
              }}
            >
              <summary>원본·상세 보기</summary>
              {advanced && (
                <>
                  {(review.firstEntry.command as QueuedChange).error && (
                    <p>{(review.firstEntry.command as QueuedChange).error}</p>
                  )}
                  <div className="conflict-columns">
                    {[
                      ["수정 전", review.base],
                      ["서버 원본", review.latest],
                      ["PC 원본", review.local],
                    ].map(([label, value]) => (
                      <section key={String(label)}>
                        <h3>{String(label)}</h3>
                        <pre>{originalText(value)}</pre>
                      </section>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      const url = URL.createObjectURL(
                        new Blob([JSON.stringify(review, null, 2)], {
                          type: "application/json",
                        }),
                      );
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = "지식서재-충돌-원문.json";
                      a.click();
                      setTimeout(() => URL.revokeObjectURL(url), 30000);
                    }}
                  >
                    입력 원문 내려받기
                  </button>
                </>
              )}
            </details>
          </div>
        </Modal>
      )}
    </>
  );
}
