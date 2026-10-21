import type { Note } from "../domain";
import type { ThoughtEvent, ThoughtMapSnapshot } from "./types";
export function confirmedChanges(
  notes: Note[],
  state: ThoughtMapSnapshot,
  topic: string,
) {
  const active = new Set(notes.map((n) => n.id));
  if (topic && !state.topics.some((t) => t.id === topic && !t.archivedAt))
    return [];
  // A source edit invalidates the evidence, not the existence of a past judgment.
  // Keep the historical topic association so the existing outdated warning is visible.
  const members = new Set(
    state.memberships
      .filter(
        (m) =>
          m.topicId === topic &&
          m.sourceKind === "note" &&
          m.status === "accepted",
      )
      .map((m) => m.sourceId),
  );
  return state.candidates.filter(
    (c) =>
      c.status === "accepted" &&
      active.has(c.before.id) &&
      active.has(c.after.id) &&
      (!topic ||
        c.topicId === topic ||
        (!c.topicId && members.has(c.before.id) && members.has(c.after.id))),
  );
}
export function timelineEvents(
  notes: Note[],
  state: ThoughtMapSnapshot,
  topic: string,
  voice: string,
  order: "oldest" | "newest" = "oldest",
): ThoughtEvent[] {
  const versions = new Map(notes.map((n) => [n.id, String(n.version)]));
  const members = new Set(
    state.memberships
      .filter(
        (m) =>
          m.topicId === topic &&
          m.sourceKind === "note" &&
          m.status !== "rejected" &&
          m.sourceVersion === versions.get(m.sourceId),
      )
      .map((m) => m.sourceId),
  );
  const active =
    !topic || state.topics.some((t) => t.id === topic && !t.archivedAt);
  return state.events
    .filter(
      (e) =>
        active &&
        versions.has(e.noteId) &&
        (voice === "all" || voice === e.voice) &&
        (!topic || members.has(e.noteId)),
    )
    .sort((a, b) => {
      if (!a.occurredOn !== !b.occurredOn) return a.occurredOn ? -1 : 1;
      const compared = (a.occurredOn ?? "").localeCompare(b.occurredOn ?? "");
      return (
        (order === "newest" ? -compared : compared) ||
        a.noteId.localeCompare(b.noteId)
      );
    });
}
export function reviewedPassage(
  note: Note,
  event: ThoughtEvent,
  quote: string,
) {
  const start = note.content.indexOf(quote);
  if (!quote.trim() || quote.length > 2000 || start < 0)
    throw Error(
      "근거 문장은 원래 기록에서 그대로 선택해 주세요. 최대 2,000자입니다.",
    );
  if (note.content.indexOf(quote, start + 1) >= 0)
    throw Error("같은 문장이 여러 번 나옵니다. 앞뒤 문장을 더 포함해 주세요.");
  return {
    noteId: note.id,
    noteVersion: note.version,
    eventVersion: event.version,
    start,
    end: start + quote.length,
    quote,
  };
}
