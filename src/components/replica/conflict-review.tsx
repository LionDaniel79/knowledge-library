"use client";
import { useEffect, useState } from "react";
import { useReplicaOptional } from "./provider";
import { Modal } from "../modal";
import {
  loadReplicaConflict,
  applyReplicaResolution,
  type ConflictReview,
  type Resolution,
} from "@/client/replica/conflicts";
import type { OutboxEntry } from "@/lib/replica/contracts";
import type { QueuedChange } from "@/client/replica/optimistic";
const textOf = (value: any) =>
  value == null
    ? "기준 자료 없음"
    : typeof value.content === "string"
      ? value.content
      : JSON.stringify(value, null, 2);
export function ConflictReviewPanel() {
  const replica = useReplicaOptional(),
    [entries, setEntries] = useState<OutboxEntry[]>([]),
    [review, setReview] = useState<ConflictReview | null>(null),
    [drafts, setDrafts] = useState<
      Record<string, { title: string; content: string }>
    >({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    if (replica?.ready)
      void replica.runtime.storage.listOutbox().then((rows) => {
        if (live)
          setEntries(
            rows.filter((e) => e.state === "conflict" || e.state === "failed"),
          );
      });
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
  if (!replica?.ready) return null;
  const runtime = replica.runtime;
  async function open(id: string) {
    setBusy(true);
    setError("");
    try {
      const r = await loadReplicaConflict(runtime.storage, id);
      setReview(r);
      setDrafts((d) =>
        d[id]
          ? d
          : {
              ...d,
              [id]: {
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
    if (!review) return;
    setBusy(true);
    setError("");
    try {
      await applyReplicaResolution(runtime.storage, review, {
        choice,
        ...(["merge", "copy"].includes(choice)
          ? { text: drafts[review.firstEntry.requestId] }
          : {}),
      });
      await runtime.notifyLocalChange();
      setReview(null);
      void runtime.sync({ reason: "local-save" }).catch(() => {});
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const draft = review ? drafts[review.firstEntry.requestId] : null,
    isNote =
      review?.entry.family === "library" &&
      ["addNote", "editNote"].includes(
        (review.entry.command as QueuedChange).body.type,
      );
  return (
    <>
      {!!entries.length && (
        <details className="panel sync-issues">
          <summary>동기화 확인 · {entries.length}개</summary>
          {entries.map((e) => (
            <div className="sync-issue" key={e.requestId}>
              <span>
                {(e.command as QueuedChange).result?.queued
                  ? "기기에 보관된 입력"
                  : "보관된 입력"}{" "}
                · {(e.command as QueuedChange).error ?? "변경 내용 확인"}
              </span>
              <button disabled={busy} onClick={() => void open(e.requestId)}>
                검토
              </button>
            </div>
          ))}
        </details>
      )}
      {error && !review && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {review && (
        <Modal
          title="동기화 충돌 확인"
          onClose={() => {
            if (!busy) setReview(null);
          }}
          canClose={!busy}
        >
          <div className="conflict-review">
            <div className="conflict-columns">
              <section>
                <h3>수정 전</h3>
                <pre>{textOf(review.base)}</pre>
              </section>
              <section>
                <h3>서버의 최신 내용</h3>
                <pre>{textOf(review.latest)}</pre>
              </section>
              <section>
                <h3>기기에 보관한 최신 입력</h3>
                <pre>{textOf(review.local)}</pre>
              </section>
            </div>
            {review.unavailable && <p role="status">{review.unavailable}</p>}
            {isNote && draft && (
              <>
                <label>
                  선택할 제목
                  <input
                    value={draft.title}
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
                    maxLength={50000}
                    value={draft.content}
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
              </>
            )}
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <div className="conflict-actions">
              <button
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
                disabled={busy || !!review.unavailable}
                onClick={() => void resolve(isNote ? "merge" : "mine")}
              >
                {isNote ? "선택한 글로 저장" : "내 입력으로 다시 저장"}
              </button>
              <button disabled={busy} onClick={() => void resolve("server")}>
                서버 내용 사용
              </button>
              {isNote && (
                <button disabled={busy} onClick={() => void resolve("copy")}>
                  새 기록으로 보관
                </button>
              )}
              <button
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
            </div>
            <p className="form-hint">선택 전의 초안도 기기에 보관합니다.</p>
          </div>
        </Modal>
      )}
    </>
  );
}
