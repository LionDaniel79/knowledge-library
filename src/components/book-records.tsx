"use client";
import { useEffect, useState, useRef } from "react";
import type { Note, ReadingCycle } from "../lib/domain";
export function BookRecords({
  bookId,
  onNote,
  onCycle,
  revision,
}: {
  bookId: string;
  onNote: (id: string) => void;
  onCycle: (c: ReadingCycle) => void;
  revision: unknown;
}) {
  const generation = useRef(0),
    inflight = useRef(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [notes, setNotes] = useState<any>(null),
    [cycles, setCycles] = useState<any>(null),
    [error, setError] = useState("");
  useEffect(() => {
    generation.current++;
    inflight.current = false;
    setLoadingMore(false);
    const c = new AbortController();
    setNotes(null);
    setCycles(null);
    setError("");
    Promise.all([
      fetch(`/api/notes?book=${bookId}`, {
        signal: c.signal,
        cache: "no-store",
      }),
      fetch(`/api/reading?book=${bookId}`, {
        signal: c.signal,
        cache: "no-store",
      }),
    ])
      .then(async (rs) => {
        const [n, r] = await Promise.all(
          rs.map(async (r) => {
            const j = await r.json();
            if (!r.ok) throw Error(j.error);
            return j;
          }),
        );
        setNotes(n);
        setCycles(r);
      })
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => c.abort();
  }, [bookId, revision]);
  async function more(kind: "notes" | "reading") {
    if (inflight.current) return;
    inflight.current = true;
    setLoadingMore(true);
    const epoch = generation.current;
    const prev = kind === "notes" ? notes : cycles;
    try {
      const r = await fetch(
          `/api/${kind}?book=${bookId}&offset=${prev.nextOffset}`,
          { cache: "no-store" },
        ),
        j = await r.json();
      if (!r.ok) throw Error(j.error);
      if (epoch !== generation.current) return;
      (kind === "notes" ? setNotes : setCycles)({
        ...j,
        items: [...prev.items, ...j.items],
      });
    } catch (e) {
      if (epoch === generation.current) setError((e as Error).message);
    } finally {
      if (epoch === generation.current) {
        inflight.current = false;
        setLoadingMore(false);
      }
    }
  }
  return (
    <>
      {error && <p role="alert">{error}</p>}
      <h3>독서 이력 {cycles?.total ?? ""}</h3>
      {cycles?.items.map((c: ReadingCycle) => (
        <div className="completed-row" key={c.id}>
          <span>
            {c.status === "reading"
              ? "읽는 중"
              : (c.completedOn ?? "날짜 미입력") + " 완독"}{" "}
            · {c.currentPage}쪽
          </span>
          <button onClick={() => onCycle(c)}>수정</button>
        </div>
      ))}
      {cycles?.total === 0 && <p>아직 독서 기록이 없습니다.</p>}
      {cycles?.nextOffset != null && (
        <button disabled={loadingMore} onClick={() => void more("reading")}>
          이력 더 보기
        </button>
      )}
      <h3>이 책에 남긴 기록 {notes?.total ?? ""}</h3>
      {notes?.items.map((n: Note) => (
        <article key={n.id} className="note-card">
          <button onClick={() => onNote(n.id)}>
            <strong>{n.title}</strong>
            <p>{n.content}</p>
          </button>
        </article>
      ))}
      {notes?.nextOffset != null && (
        <button disabled={loadingMore} onClick={() => void more("notes")}>
          기록 더 보기
        </button>
      )}
    </>
  );
}
