"use client";
import { useRef, useState } from "react";
import type { Book, Library } from "@/lib/domain";
import { BookPicker } from "./book-picker";
const names: Record<string, string> = {
  same_file: "동일한 PDF 파일",
  same_edition: "같은 판본의 소장본",
  different_edition: "다른 번역·개정 판본",
};
type RelatedBook = {
  id: string;
  title: string;
  author: string;
  isbn: string;
  version: number;
  same_file?: boolean;
};
export function BookRelations({
  book,
  library,
}: {
  book: Book;
  library: Library;
}) {
  const [data, setData] = useState<any>(null),
    [selected, setSelected] = useState<RelatedBook | null>(null),
    [relation, setRelation] = useState("same_edition"),
    [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const requests = useRef(new Map<string, string>());
  async function load() {
    setError("");
    const r = await fetch("/api/book-relations?bookId=" + book.id, {
        cache: "no-store",
      }),
      j = await r.json();
    if (!r.ok) throw Error(j.error ?? "연결 정보를 읽지 못했습니다.");
    setData(j);
  }
  async function save(payload: Record<string, unknown>) {
    if (busy) return;
    setBusy(true);
    setError("");
    const key = JSON.stringify(payload),
      requestId = requests.current.get(key) ?? crypto.randomUUID();
    requests.current.set(key, requestId);
    try {
      const r = await fetch("/api/book-relations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...payload, requestId }),
        }),
        j = await r.json();
      if (!r.ok) {
        if (r.status < 500) requests.current.delete(key);
        throw Error(j.error ?? "연결을 저장하지 못했습니다.");
      }
      requests.current.delete(key);
      await load();
      setSelected(null);
      setReason("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function choose(b: RelatedBook) {
    setSelected(b);
    setRelation(b.same_file ? "same_file" : "same_edition");
    setReason("");
  }
  return (
    <details
      className="curation-details"
      onToggle={(e) => {
        if (e.currentTarget === e.target && e.currentTarget.open && !data)
          void load().catch((e) => setError(e.message));
      }}
    >
      <summary>다른 소장본·판본 연결</summary>
      <p className="form-hint">
        파일이 같거나 ISBN이 같은 자료를 후보로 보여 줍니다. 연결해도 각 책의
        위치·독서 이력·메모는 그대로 남습니다.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {data && (
        <>
          {!data.localAvailable && (
            <p>
              이 환경에서는 PDF 파일 비교를 할 수 없습니다. ISBN 비교와 판본
              연결은 사용할 수 있습니다.
            </p>
          )}
          {data.candidates.map((c: RelatedBook) => (
            <article key={c.id}>
              <strong>{c.title}</strong>
              <p>
                {c.author} · {c.isbn || "ISBN 미입력"}
              </p>
              <button type="button" disabled={busy} onClick={() => choose(c)}>
                {c.same_file ? "동일 파일 후보 확인" : "같은 ISBN 후보 확인"}
              </button>
            </article>
          ))}
          {!data.candidates.length && (
            <p>
              동일 파일·ISBN 후보가 없습니다. 다른 판본은 직접 선택할 수
              있습니다.
            </p>
          )}
          <details>
            <summary>도서를 직접 찾아 비교</summary>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const id = new FormData(e.currentTarget).get("bookId");
                if (id === book.id) {
                  setError("서로 다른 도서를 선택해 주세요.");
                  return;
                }
                setBusy(true);
                void fetch("/api/books/" + id, { cache: "no-store" })
                  .then(async (r) => {
                    const j = await r.json();
                    if (!r.ok) throw Error(j.error ?? "도서 조회 실패");
                    choose(j);
                  })
                  .catch((e) => setError(e.message))
                  .finally(() => setBusy(false));
              }}
            >
              <BookPicker library={library} required disabled={busy} />
              <button disabled={busy}>선택한 도서 비교</button>
            </form>
          </details>
          {selected && (
            <form
              className="thought-form"
              onSubmit={(e) => {
                e.preventDefault();
                const prior = data.relations.find(
                  (r: any) =>
                    r.left_id === selected.id || r.right_id === selected.id,
                );
                void save({
                  leftId: book.id,
                  rightId: selected.id,
                  leftVersion: data.source.version,
                  rightVersion: selected.version,
                  relation,
                  state: "accepted",
                  reason,
                  expectedVersion: prior?.version ?? 0,
                });
              }}
            >
              <h4>
                {book.title} ↔ {selected.title}
              </h4>
              <p>
                {selected.author} · {selected.isbn || "ISBN 미입력"}
              </p>
              <label>
                소장본 관계
                <select
                  value={relation}
                  onChange={(e) => setRelation(e.target.value)}
                >
                  {Object.entries(names).map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                확인한 근거
                <textarea
                  required
                  maxLength={2000}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="판권면·ISBN·번역자 등을 어떻게 확인했나요?"
                />
              </label>
              <button className="primary" disabled={busy}>
                확인한 관계 저장
              </button>
            </form>
          )}
          {data.relations.map((r: any) => (
            <article className="curation-item" key={r.id}>
              <strong>
                {r.left_id === book.id ? r.right_title : r.left_title}
              </strong>
              <p>
                {names[r.relation]} ·{" "}
                {r.state === "accepted"
                  ? r.freshness === "current"
                    ? "연결됨"
                    : "이전 확인 기록"
                  : "연결 해제됨"}
              </p>
              {r.freshness === "stale" && (
                <p className="notice">
                  도서 정보나 PDF가 변경되었습니다. 이전 판단은 보관되며, 관계를
                  다시 확인해야 합니다.
                </p>
              )}
              {r.freshness === "unavailable" && (
                <p className="notice">
                  현재 원본 파일의 동일 여부를 확인할 수 없습니다. 원본이 있는
                  PC에서 다시 확인해 주세요.
                </p>
              )}
              <details>
                <summary>확인 근거</summary>
                <p>{r.reason}</p>
                <p>확인 시각: {r.evidence.confirmedAt ?? "기록 없음"}</p>
                <p>
                  당시 ISBN:{" "}
                  {(r.evidence.books ?? [])
                    .map((b: any) => b.isbn || "미입력")
                    .join(" / ")}
                </p>
              </details>
              {r.state === "accepted" && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void save({
                      leftId: r.left_id,
                      rightId: r.right_id,
                      leftVersion: r.left_version,
                      rightVersion: r.right_version,
                      expectedVersion: r.version,
                      relation: r.relation,
                      state: "withdrawn",
                      reason: "사용자가 연결 해제",
                    })
                  }
                >
                  연결 해제
                </button>
              )}
            </article>
          ))}
        </>
      )}
    </details>
  );
}
