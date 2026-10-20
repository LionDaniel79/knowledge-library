"use client";
import { useState } from "react";
import type { Library, Note } from "@/lib/domain";
import {
  thoughtRelationNames,
  type ThoughtMapSnapshot,
  type ThoughtEvent,
} from "@/lib/thought-map/types";
import { TopicPicker, type ThoughtSend } from "./topic-picker";
import { timelineEvents, confirmedChanges } from "@/lib/thought-map/timeline";
import { ManualComparison } from "./manual-comparison";
import { ReviewCard } from "./candidate-review";
import {
  useListPagination,
  PageSizeSelect,
  PageNavigation,
} from "../list-pagination";
const voices = {
  self: "내 생각",
  quote: "책에서 옮긴 구절",
  unconfirmed: "확인 전",
};
function EventCard({
  note,
  event,
  state,
  send,
  busy,
  onOpen,
}: {
  note: Note;
  event: ThoughtEvent;
  state: ThoughtMapSnapshot;
  send: ThoughtSend;
  busy: boolean;
  onOpen: (kind: string, id: string) => void;
}) {
  const [date, setDate] = useState(event.occurredOn ?? ""),
    [voice, setVoice] = useState(event.voice);
  return (
    <article className="panel thought-event">
      <small>
        {event.occurredOn ?? "날짜 미상"} · {voices[event.voice]} ·{" "}
        {event.dateSource === "legacy"
          ? "원본 기록 날짜"
          : event.dateSource === "user"
            ? "내가 확인한 날짜"
            : event.dateSource === "native"
              ? "처음 작성한 날짜"
              : "원본 날짜 확인 필요"}
      </small>
      <button className="thought-title" onClick={() => onOpen("note", note.id)}>
        {note.title}
      </button>
      <p>{note.content}</p>
      <details>
        <summary>날짜·발화 주체·주제 수정</summary>
        <form
          className="thought-form"
          onSubmit={(e) => {
            e.preventDefault();
            void send("setThoughtEvent", {
              noteId: note.id,
              expectedVersion: event.version,
              occurredOn: date || null,
              voice,
            });
          }}
        >
          <label>
            생각한 날짜
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
          <label>
            누구의 생각인가요?
            <select
              value={voice}
              onChange={(e) =>
                setVoice(e.target.value as ThoughtEvent["voice"])
              }
            >
              {Object.entries(voices).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <button disabled={busy} className="primary">
            날짜·발화 주체 저장
          </button>
        </form>
        <TopicPicker
          topics={state.topics}
          memberships={state.memberships}
          source={{ id: note.id, kind: "note", version: note.version }}
          send={send}
          busy={busy}
        />
      </details>
    </article>
  );
}
export function ThoughtTimeline({
  library,
  state,
  send,
  busy,
  onOpen,
}: {
  library: Library;
  state: ThoughtMapSnapshot;
  send: ThoughtSend;
  busy: boolean;
  onOpen: (kind: string, id: string) => void;
}) {
  const [topic, setTopic] = useState(""),
    [voice, setVoice] = useState("all");
  const events = timelineEvents(library.notes, state, topic, voice);
  const paging = useListPagination(
    "thought-timeline",
    JSON.stringify([topic, voice]),
  );
  const visibleEvents = events.slice(
    paging.offset,
    paging.offset + paging.size,
  );
  const personal = timelineEvents(library.notes, state, topic, "self").filter(
    (e) => !!e.occurredOn,
  );
  const confirmed = confirmedChanges(library.notes, state, topic);
  const cards = (list: ThoughtEvent[]) =>
    list.map((e) => {
      const n = library.notes.find((n) => n.id === e.noteId);
      return n ? (
        <EventCard
          key={`${e.noteId}:${e.version}`}
          note={n}
          event={e}
          state={state}
          send={send}
          busy={busy}
          onOpen={onOpen}
        />
      ) : null;
    });
  return (
    <div className="thought-timeline">
      <div className="panel thought-filters">
        <h2>시간에 따라 달라진 나의 생각</h2>
        <p>
          기록의 문장을 고친 이력과 생각이 달라진 흐름을 구분합니다. 아래 연결은
          내가 확인한 변화만 표시합니다.
        </p>
        <label>
          주제별 흐름
          <select value={topic} onChange={(e) => setTopic(e.target.value)}>
            <option value="">모든 주제</option>
            {state.topics
              .filter((t) => t.confirmed)
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          기록의 발화 주체
          <select value={voice} onChange={(e) => setVoice(e.target.value)}>
            <option value="all">전체 · 인용·확인 전 포함</option>
            {Object.entries(voices).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <section className="panel">
        <h3>내가 확인한 변화</h3>
        {confirmed.map((c) => (
          <article className="confirmed-change" key={c.id}>
            <strong>
              {c.before.occurredOn} → {c.after.occurredOn} ·{" "}
              {thoughtRelationNames[c.comparison.relation]}
            </strong>
            <p>{c.comparison.explanation}</p>
            {c.outdated && (
              <p className="notice">
                원문 또는 날짜가 수정되었습니다. 당시 판단을 보존한 기록이며
                재검토가 필요합니다.
              </p>
            )}
            <details>
              <summary>근거·판단 수정·이력</summary>
              <ReviewCard
                key={`${c.id}:${c.version}`}
                candidate={c}
                send={send}
                busy={busy}
                onOpen={onOpen}
                feedback={state.feedback}
              />
            </details>
            <button onClick={() => onOpen("note", c.before.id)}>
              이전 기록
            </button>
            <button onClick={() => onOpen("note", c.after.id)}>
              이후 기록
            </button>
          </article>
        ))}
        {!confirmed.length && (
          <p>
            확인한 변화가 아직 없습니다. 직접 연결하거나 후보를 검토해 주세요.
          </p>
        )}
      </section>
      <ManualComparison
        notes={library.notes}
        events={personal}
        topicId={topic}
        send={send}
        busy={busy}
        onOpen={onOpen}
      />
      <PageSizeSelect label="사유의 지도 기록" paging={paging} />
      {cards(visibleEvents.filter((e) => e.occurredOn))}
      {visibleEvents.some((e) => !e.occurredOn) && (
        <section>
          <h3>날짜를 확인할 기록</h3>
          {cards(visibleEvents.filter((e) => !e.occurredOn))}
        </section>
      )}
      {!events.length && <p>선택한 조건에 맞는 기록이 없습니다.</p>}
      <PageNavigation
        label="사유의 지도 기록"
        paging={paging}
        total={events.length}
      />
    </div>
  );
}
