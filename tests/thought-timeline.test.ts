import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  timelineEvents,
  reviewedPassage,
} from "../src/lib/thought-map/timeline";
import type { Note } from "../src/lib/domain";
import type {
  ThoughtMapSnapshot,
  ThoughtEvent,
} from "../src/lib/thought-map/types";
it("filters timeline using current confirmed topic membership, sorting unknown dates last", () => {
  const topic = randomUUID(),
    notes = [0, 1, 2].map(
      (i) =>
        ({
          id: randomUUID(),
          version: 1,
          content: "기록",
          title: `기록${i}`,
        }) as Note,
    );
  const events = notes.map(
    (n, i) =>
      ({
        noteId: n.id,
        occurredOn: i === 2 ? null : `202${1 - i}-01-01`,
        voice: "self",
        version: 0,
      }) as ThoughtEvent,
  );
  const state = {
    topics: [{ id: topic, confirmed: true }],
    memberships: notes.map((n, i) => ({
      topicId: topic,
      sourceKind: "note",
      sourceId: n.id,
      sourceVersion: i === 0 ? "0" : "1",
      status: "accepted",
    })),
    events,
  } as ThoughtMapSnapshot;
  expect(
    timelineEvents(notes, state, topic, "all").map((e) => e.noteId),
  ).toEqual([notes[1].id, notes[2].id]);
  state.topics[0].confirmed = false;
  expect(timelineEvents(notes, state, topic, "all")).toEqual([]);
  expect(timelineEvents(notes, state, "", "all").map((e) => e.noteId)).toEqual([
    notes[1].id,
    notes[0].id,
    notes[2].id,
  ]);
});
it("keeps exact selected excerpt offsets and rejects missing or ambiguous passages", () => {
  const note = {
    id: randomUUID(),
    version: 3,
    content: "처음 문장. 중요한 근거. 마지막 문장.",
  } as Note;
  const event = { version: 2 } as ThoughtEvent;
  expect(reviewedPassage(note, event, "중요한 근거.")).toEqual({
    noteId: note.id,
    noteVersion: 3,
    eventVersion: 2,
    start: 7,
    end: 14,
    quote: "중요한 근거.",
  });
  expect(() => reviewedPassage(note, event, "요약해서 쓴 문장")).toThrow();
  expect(() =>
    reviewedPassage({ ...note, content: "반복 반복" }, event, "반복"),
  ).toThrow();
});
