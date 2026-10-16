"use client";
import type { Membership, Topic } from "@/lib/thought-map/types";
export type ThoughtSend = (type: string, payload: unknown) => Promise<void>;
export function TopicPicker({
  topics,
  memberships,
  source,
  send,
  busy,
}: {
  topics: Topic[];
  memberships: Membership[];
  source: { id: string; kind: "note" | "book"; version: number };
  send: ThoughtSend;
  busy: boolean;
}) {
  return (
    <fieldset className="topic-picker">
      <legend>분류할 주제 · 여러 개 선택 가능</legend>
      {topics.length === 0 && <p>먼저 주제를 만들어 주세요.</p>}
      {topics.map((t) => {
        const m = memberships.find(
          (m) =>
            m.topicId === t.id &&
            m.sourceKind === source.kind &&
            m.sourceId === source.id,
        );
        return (
          <label key={t.id}>
            <input
              type="checkbox"
              checked={m?.status === "accepted"}
              disabled={busy}
              onChange={(e) =>
                void send("assignTopic", {
                  topicId: t.id,
                  sourceKind: source.kind,
                  sourceId: source.id,
                  sourceVersion: String(source.version),
                  status: e.target.checked ? "accepted" : "rejected",
                  expectedVersion: m?.version ?? 0,
                })
              }
            />
            {t.name}
            {m?.status === "suggested" && <small>제안</small>}
          </label>
        );
      })}
    </fieldset>
  );
}
