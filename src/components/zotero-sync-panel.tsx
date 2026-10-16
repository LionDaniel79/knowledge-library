"use client";
import { useEffect, useRef, useState } from "react";
import { Modal } from "./modal";
import type { SyncBook, SyncPlan } from "@/lib/zotero-sync";
const names = {
  create: "새로 추가",
  link: "기존 항목 연결",
  update: "서지 갱신",
  unchanged: "변경 없음",
  review: "확인 필요",
  excluded: "대상 제외",
};
export function ZoteroSyncPanel({
  book,
  onClose,
  onSynced,
}: {
  book?: SyncBook;
  onClose: () => void;
  onSynced?: () => void;
}) {
  const [books, setBooks] = useState<SyncBook[]>(book ? [book] : []),
    [nextCursor, setNextCursor] = useState<string | null>(null),
    [query, setQuery] = useState(""),
    [pending, setPending] = useState(true),
    [chosen, setChosen] = useState<string[]>(book ? [book.id] : []),
    [plan, setPlan] = useState<SyncPlan | null>(null),
    [selected, setSelected] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [help, setHelp] = useState(false);
  const requests = useRef(new Map<string, string>());
  async function load(cursor?: string) {
    setBusy(true);
    setError("");
    setPlan(null);
    try {
      const u = new URL("/api/zotero-sync", location.origin);
      u.searchParams.set("q", query);
      u.searchParams.set("pending", String(pending));
      if (cursor) u.searchParams.set("cursor", cursor);
      const r = await fetch(u, { cache: "no-store" }),
        j = await r.json();
      if (!r.ok) throw Error(j.error ?? "목록을 읽지 못했습니다.");
      setBooks(j.books);
      setChosen(j.books.map((b: SyncBook) => b.id));
      setNextCursor(j.nextCursor);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!book) void load();
  }, []); // Initial page; subsequent queries are explicit.
  async function preview() {
    setBusy(true);
    setError("");
    setMessage("");
    setPlan(null);
    try {
      const r = await fetch("/api/zotero-sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "preview", bookIds: chosen }),
        }),
        j = await r.json();
      if (!r.ok) throw Error(j.error ?? "미리보기를 만들지 못했습니다.");
      setPlan(j);
      setSelected(
        j.entries
          .filter((e: SyncPlan["entries"][number]) =>
            ["create", "link", "update"].includes(e.action),
          )
          .map((e: SyncPlan["entries"][number]) => e.book.id),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function apply() {
    if (!plan) return;
    setBusy(true);
    setError("");
    setMessage("");
    const payload = {
        bookIds: plan.entries.map((e) => e.book.id),
        selectedIds: selected,
        fingerprint: plan.fingerprint,
      },
      key = JSON.stringify(payload),
      requestId = requests.current.get(key) ?? crypto.randomUUID();
    requests.current.set(key, requestId);
    try {
      const r = await fetch("/api/zotero-sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "apply", requestId, ...payload }),
        }),
        j = await r.json();
      if (!r.ok) {
        if (r.status === 409) setPlan(null);
        throw Error(
          j.error ??
            "전송 상태를 확인하지 못했습니다. 미리보기로 다시 확인하세요.",
        );
      }
      requests.current.delete(key);
      setPlan(null);
      setMessage(
        j.completed +
          "권 반영 완료" +
          (j.failed
            ? " · " + j.failed + "권은 미리보기에서 다시 확인하세요."
            : "."),
      );
      onSynced?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const toggle = (current: string[], id: string) =>
    current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
  return (
    <Modal title="Zotero 서지 전송" onClose={onClose} canClose={!busy}>
      <p>
        책 정보를 확인한 뒤 선택한 책만 보냅니다. PDF와 개인 기록은 보내지
        않습니다.
      </p>
      <button type="button" onClick={() => setHelp(!help)} aria-expanded={help}>
        사용법
      </button>
      {help && (
        <div className="notice">
          <p>
            ① 도서 선택 → ② 전송 미리보기 → ③ 선택한 책 전송 순서입니다. 한 번에
            최대 50권을 확인합니다.
          </p>
          <p>
            이미 보낸 책을 갱신하려면 ‘아직 연결하지 않은 책만’을 끄고
            검색하세요. Zotero에서 고친 서지는 자동으로 덮어쓰지 않습니다. ‘확인
            필요’ 자료는 양쪽 판본과 정보를 직접 비교하세요.
          </p>
          <p>
            연결된 PC에서 이용할 수 있습니다. 오류가 나면 미리보기로 다시
            확인하세요. 전송 결과가 불확실해도 같은 책을 중복 생성하지 않도록
            확인합니다.
          </p>
          <p>
            제목·기존 저자 표기·출판사·유효한 ISBN만 보냅니다. 저자
            구분·번역자·출판 연도 등은 Zotero에서 확인하고 보완하세요. 이 기능은
            지식서재에서 Zotero로 보내는 서지 전송이며 메모나 파일의 양방향
            동기화는 아닙니다.
          </p>
        </div>
      )}
      {!book && (
        <form
          className="knowledge-controls"
          onSubmit={(e) => {
            e.preventDefault();
            void load();
          }}
        >
          <label>
            책 찾기
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="제목 또는 저자"
              disabled={busy}
            />
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={pending}
              onChange={(e) => setPending(e.target.checked)}
              disabled={busy}
            />
            아직 연결하지 않은 책만
          </label>
          <button disabled={busy}>목록 조회</button>
        </form>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="notice">
          {message}
        </p>
      )}
      {!plan ? (
        <>
          <div className="zotero-book-list">
            {books.map((b) => (
              <label className="zotero-book-row" key={b.id}>
                <input
                  type="checkbox"
                  checked={chosen.includes(b.id)}
                  onChange={() => setChosen(toggle(chosen, b.id))}
                  disabled={busy}
                />
                <span>
                  <strong>{b.title}</strong>
                  <small>
                    {b.author || "저자 확인 필요"} ·{" "}
                    {b.publisher || "출판사 확인 필요"}
                  </small>
                </span>
              </label>
            ))}
          </div>
          {!busy && !books.length && <p>해당 도서가 없습니다.</p>}
          <div className="form-actions">
            <button
              className="primary"
              disabled={busy || !chosen.length}
              onClick={() => void preview()}
            >
              전송 미리보기
            </button>
            {!book && nextCursor && (
              <button disabled={busy} onClick={() => void load(nextCursor)}>
                다음 50권
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="zotero-book-list">
            {plan.entries.map((e) => (
              <div className="zotero-book-row" key={e.book.id}>
                <input
                  aria-label={e.book.title + " 전송 선택"}
                  type="checkbox"
                  disabled={
                    busy || !["create", "link", "update"].includes(e.action)
                  }
                  checked={selected.includes(e.book.id)}
                  onChange={() => setSelected(toggle(selected, e.book.id))}
                />
                <div>
                  <strong>{e.book.title}</strong>
                  <p>
                    <b>{names[e.action]}</b> · {e.reason}
                  </p>
                  <small>
                    {e.book.author || "저자 미상"} ·{" "}
                    {e.book.publisher || "출판사 미상"} · ISBN{" "}
                    {e.data.ISBN || "없음"}
                  </small>
                  {e.remote && (
                    <details>
                      <summary>Zotero 정보와 비교</summary>
                      <p>
                        {e.remote.data.title} ·{" "}
                        {e.remote.data.creators
                          .map(
                            (c) =>
                              c.name ||
                              [c.firstName, c.lastName]
                                .filter(Boolean)
                                .join(" "),
                          )
                          .join("; ")}{" "}
                        · {e.remote.data.publisher} · {e.remote.data.ISBN}
                      </p>
                      <a
                        href={
                          "https://www.zotero.org/users/" +
                          plan.libraryId +
                          "/items/" +
                          e.key
                        }
                        target="_blank"
                        rel="noreferrer"
                      >
                        Zotero 항목 열기
                      </a>
                    </details>
                  )}
                </div>
              </div>
            ))}
          </div>
          <div className="form-actions">
            <button
              className="primary"
              disabled={busy || !selected.length}
              onClick={() => void apply()}
            >
              선택한 {selected.length}권 전송
            </button>
            <button disabled={busy} onClick={() => setPlan(null)}>
              도서 다시 선택
            </button>
          </div>
        </>
      )}
      {busy && <p role="status">연결을 확인하고 있습니다…</p>}
    </Modal>
  );
}
