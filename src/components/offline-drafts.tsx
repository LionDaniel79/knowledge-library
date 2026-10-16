"use client";
import { useEffect, useState } from "react";
import {
  readDrafts,
  replaceDraft,
  dropDraft,
  rebaseDraft,
  copyDraft,
  offlineOwnerKey,
  type Draft,
} from "@/lib/offline-drafts";
import type { Note } from "@/lib/domain";
export function OfflineDrafts({
  ownerId,
  revision,
  onSaved,
}: {
  ownerId: string;
  revision: number;
  onSaved: () => Promise<void>;
}) {
  const [drafts, setDrafts] = useState<Draft[]>([]),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [conflicts, setConflicts] = useState<Record<string, Note>>({}),
    [enabled, setEnabled] = useState(false);
  function load() {
    try {
      setDrafts(readDrafts(localStorage, ownerId));
      setEnabled(localStorage.getItem(offlineOwnerKey) === ownerId);
    } catch {
      setMessage("이 브라우저에서 임시 기록 저장소를 열 수 없습니다.");
    }
  }
  useEffect(() => {
    load();
    window.addEventListener("storage", load);
    return () => window.removeEventListener("storage", load);
  }, [ownerId, revision]);
  async function send(d: Draft) {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      const r = await fetch("/api/library", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(d.command),
        }),
        j = await r.json();
      if (r.status === 409 && d.command.type === "editNote") {
        const current = await fetch("/api/notes/" + d.command.payload.id, {
          cache: "no-store",
        });
        if (!current.ok)
          throw Error("로그인 후 최신 기록을 다시 확인해 주세요.");
        const latest = await current.json();
        if (latest) setConflicts((c) => ({ ...c, [d.id]: latest }));
        throw Error(
          "다른 기기의 수정 내용과 충돌했습니다. 두 글을 비교한 후 결정하세요.",
        );
      }
      if (!r.ok)
        throw Error(
          j.error ?? "서재에 저장하지 못했습니다. 기기 초안은 유지됩니다.",
        );
      dropDraft(localStorage, ownerId, d.id);
      load();
      setMessage("서재에 저장했습니다.");
      await onSaved();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function replace(old: Draft, next: Draft) {
    try {
      replaceDraft(localStorage, old, next);
      setConflicts((c) => {
        const copy = { ...c };
        delete copy[old.id];
        return copy;
      });
      load();
      setMessage(
        "검토한 초안을 보관했습니다. 서재에 저장 버튼으로 반영하세요.",
      );
    } catch (e) {
      setMessage((e as Error).message);
    }
  }
  return (
    <details className="panel offline-drafts">
      <summary>이 기기의 임시 기록 · {drafts.length}개</summary>
      <p>
        ‘기기에 임시 저장’을 누른 글만 이 브라우저에 보관합니다. 서재로 보내기
        전까지 다른 기기에서는 보이지 않습니다. 공용 기기에서는 사용하지 마세요.
      </p>
      <button
        type="button"
        onClick={() => {
          try {
            if (enabled) localStorage.removeItem(offlineOwnerKey);
            else localStorage.setItem(offlineOwnerKey, ownerId);
            load();
          } catch {
            setMessage("기기 설정을 저장하지 못했습니다.");
          }
        }}
      >
        {enabled ? "오프라인 새 기록 사용 끄기" : "오프라인 새 기록 사용 켜기"}
      </button>
      {enabled && <a href="/offline.html">오프라인 기록 화면</a>}
      {message && <p role="status">{message}</p>}
      {drafts.map((d) => (
        <article className="curation-item" key={d.id}>
          <h3>{d.command.payload.title}</h3>
          <small>
            {new Date(d.createdAt).toLocaleString("ko-KR")} ·{" "}
            {d.command.type === "editNote"
              ? "기존 기록 수정 초안"
              : "새 기록 초안"}
          </small>
          <p className="source-quote">{d.command.payload.content}</p>
          {conflicts[d.id] && (
            <form
              className="knowledge-controls"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                replace(
                  d,
                  rebaseDraft(d, conflicts[d.id], {
                    title: String(f.get("title")),
                    content: String(f.get("content")),
                  }),
                );
              }}
            >
              <h4>현재 서재의 글</h4>
              <p>{conflicts[d.id].title}</p>
              <p className="source-quote">{conflicts[d.id].content}</p>
              <p>
                현재 서재의 책 연결·쪽수·기록 종류·태그를 유지하고, 아래에서
                비교한 제목과 글만 반영합니다.
              </p>
              <label>
                비교 후 남길 제목
                <input
                  name="title"
                  maxLength={300}
                  defaultValue={d.command.payload.title}
                  required
                />
              </label>
              <label>
                비교 후 남길 글
                <textarea
                  name="content"
                  maxLength={50000}
                  defaultValue={d.command.payload.content}
                  required
                />
              </label>
              <button disabled={busy}>비교한 내용으로 초안 갱신</button>
              <button
                type="button"
                disabled={busy}
                onClick={() => replace(d, copyDraft(d))}
              >
                기존 글을 두고 새 생각으로 보관
              </button>
            </form>
          )}
          <div className="form-footer">
            <button
              disabled={busy || !!conflicts[d.id]}
              onClick={() => void send(d)}
            >
              서재에 저장
            </button>
            <button
              disabled={busy}
              onClick={() => {
                const a = document.createElement("a"),
                  url = URL.createObjectURL(
                    new Blob(
                      [
                        `${d.command.payload.title}\n\n${d.command.payload.content}`,
                      ],
                      { type: "text/plain;charset=utf-8" },
                    ),
                  );
                a.href = url;
                a.download = "서재-임시기록.txt";
                a.click();
                URL.revokeObjectURL(url);
              }}
            >
              글 내려받기
            </button>
            <button
              disabled={busy}
              onClick={() => {
                dropDraft(localStorage, ownerId, d.id);
                load();
              }}
            >
              기기 초안 삭제
            </button>
          </div>
        </article>
      ))}
    </details>
  );
}
