"use client";
import { libraryRequest } from "@/client/replica/request";
import { useState } from "react";
import type { Note } from "@/lib/domain";
import {
  thoughtRelationNames,
  type ThoughtEvent,
} from "@/lib/thought-map/types";
import { reviewedPassage } from "@/lib/thought-map/timeline";
import type { ThoughtSend } from "./topic-picker";
type Selection = { note: Note; event: ThoughtEvent; quote: string };
export function ManualComparison({
  notes,
  events,
  topicId,
  send,
  busy,
  onOpen,
}: {
  notes: Note[];
  events: ThoughtEvent[];
  topicId: string;
  send: ThoughtSend;
  busy: boolean;
  onOpen: (kind: string, id: string) => void;
}) {
  const [before, setBefore] = useState<Selection | null>(null),
    [after, setAfter] = useState<Selection | null>(null),
    [relation, setRelation] = useState("expands"),
    [explanation, setExplanation] = useState(""),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
  async function choose(id: string, set: (s: Selection | null) => void) {
    set(null);
    setError("");
    let note = notes.find((n) => n.id === id);
    const event = events.find((e) => e.noteId === id);
    if (!note || !event) return;
    setLoading(true);
    try {
      if (note.summary) {
        const r = await libraryRequest("/api/notes/" + id, { cache: "no-store" }),
          full = await r.json();
        if (!r.ok) throw Error(full.error);
        if (full.version !== note.version)
          throw Error("기록이 변경되었습니다. 새로고침 후 다시 선택하세요.");
        note = full;
      }
      set({
        note: note!,
        event,
        quote: Array.from(note!.content).slice(0, 800).join(""),
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  const stale = (s: Selection | null) =>
    !!s &&
    (notes.find((n) => n.id === s.note.id)?.version !== s.note.version ||
      events.find((e) => e.noteId === s.note.id)?.version !== s.event.version);
  return (
    <details className="panel">
      <summary>내 생각의 변화를 직접 연결</summary>
      <form
        className="thought-form"
        onSubmit={(e) => {
          e.preventDefault();
          setError("");
          try {
            if (!before || !after)
              throw Error("비교할 두 기록을 선택해 주세요.");
            if (
              !before.event.occurredOn ||
              !after.event.occurredOn ||
              before.event.occurredOn >= after.event.occurredOn
            )
              throw Error("이전 생각보다 나중 날짜의 기록을 선택해 주세요.");
            if (stale(before) || stale(after))
              throw Error(
                "기록이 변경되었습니다. 선택 상자에서 최신 기록을 다시 선택해 주세요.",
              );
            void send("connectThoughts", {
              beforeId: before.note.id,
              afterId: after.note.id,
              topicId: topicId || null,
              relation,
              explanation,
              reviewedRecords: {
                before: reviewedPassage(
                  before.note,
                  before.event,
                  before.quote,
                ),
                after: reviewedPassage(after.note, after.event, after.quote),
              },
            });
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        <p className="form-hint">
          현재 선택한 주제 안에서, 날짜를 확인한 내 생각만 비교합니다. 인용문과
          날짜 미상 기록은 아래에서 먼저 확인해 주세요.
        </p>
        <div className="evidence-pair">
          {[
            { label: "이전 생각", selected: before, set: setBefore },
            { label: "이후 생각", selected: after, set: setAfter },
          ].map(({ label, selected, set }) => (
            <section key={label}>
              <label>
                {label}
                <select
                  required
                  value={selected?.note.id ?? ""}
                  disabled={loading}
                  onChange={(e) => void choose(e.target.value, set)}
                >
                  <option value="">기록 선택</option>
                  {events.map((e) => (
                    <option key={e.noteId} value={e.noteId}>
                      {e.occurredOn} ·{" "}
                      {notes.find((n) => n.id === e.noteId)?.title}
                    </option>
                  ))}
                </select>
              </label>
              {selected && (
                <>
                  <details>
                    <summary>기록 전체 읽기</summary>
                    <p className="preserve-lines">{selected.note.content}</p>
                    <button
                      type="button"
                      onClick={() => onOpen("note", selected.note.id)}
                    >
                      원래 기록 열기
                    </button>
                  </details>
                  <label>
                    {label}의 근거 문장
                    <textarea
                      maxLength={2000}
                      required
                      value={selected.quote}
                      onChange={(e) =>
                        set({ ...selected, quote: e.target.value })
                      }
                    />
                  </label>
                  <p className="form-hint">
                    원문 문장을 그대로 남겨 주세요. 판단의 이유는 아래에 따로
                    적습니다.
                  </p>
                  {stale(selected) && (
                    <p className="notice">
                      선택 후 기록이 변경되었습니다. 다시 선택해 주세요.
                    </p>
                  )}
                </>
              )}
            </section>
          ))}
        </div>
        <label>
          변화의 종류
          <select
            value={relation}
            onChange={(e) => setRelation(e.target.value)}
          >
            {Object.entries(thoughtRelationNames)
              .filter(([id]) => id !== "uncertain")
              .map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
          </select>
        </label>
        <label>
          내가 판단한 이유
          <textarea
            required
            maxLength={1200}
            value={explanation}
            onChange={(e) => setExplanation(e.target.value)}
          />
        </label>
        <p className="form-hint">
          같은 날짜의 기록이나 인용문은 ‘사유의 연결’에서 관련 자료로 묶을 수
          있습니다.
        </p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button
          className="primary"
          disabled={busy || loading || !before || !after}
        >
          변화 연결 확정
        </button>
      </form>
    </details>
  );
}
