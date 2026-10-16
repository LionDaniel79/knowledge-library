import type { Note } from "../domain";
import type { ThoughtEvent, ThoughtMapSnapshot } from "./types";
export function timelineEvents(
  notes: Note[],
  state: ThoughtMapSnapshot,
  topic: string,
  voice: string,
): ThoughtEvent[] {
  const versions = new Map(notes.map((n) => [n.id, String(n.version)]));
  const members = new Set(
    state.memberships
      .filter(
        (m) =>
          m.topicId === topic &&
          m.sourceKind === "note" &&
          m.status === "accepted" &&
          m.sourceVersion === versions.get(m.sourceId),
      )
      .map((m) => m.sourceId),
  );
  const confirmed =
    !topic || state.topics.some((t) => t.id === topic && t.confirmed);
  return state.events
    .filter(
      (e) =>
        confirmed &&
        versions.has(e.noteId) &&
        (voice === "all" || voice === e.voice) &&
        (!topic || members.has(e.noteId)),
    )
    .sort(
      (a, b) =>
        (a.occurredOn ?? "9999").localeCompare(b.occurredOn ?? "9999") ||
        a.noteId.localeCompare(b.noteId),
    );
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
