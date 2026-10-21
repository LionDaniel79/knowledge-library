import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  timelineEvents,
  reviewedPassage,
  confirmedChanges,
} from "../src/lib/thought-map/timeline";
import type { Note } from "../src/lib/domain";
import type {
  ThoughtMapSnapshot,
  ThoughtEvent,
} from "../src/lib/thought-map/types";
it("browses active topics without approving suggested classifications and sorts unknown dates last", () => {
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
  state.memberships[1].status = "suggested";
  expect(
    timelineEvents(notes, state, topic, "all").map((e) => e.noteId),
  ).toEqual([notes[1].id, notes[2].id]);
  expect(state.memberships[1].status).toBe("suggested");
  expect(
    timelineEvents(notes, state, "", "all", "newest").map((e) => e.noteId),
  ).toEqual([notes[0].id, notes[1].id, notes[2].id]);
  state.topics[0].archivedAt = "2026-10-21T00:00:00Z";
  expect(timelineEvents(notes, state, topic, "all")).toEqual([]);
  expect(timelineEvents(notes, state, "", "all").map((e) => e.noteId)).toEqual([
    notes[1].id,
    notes[0].id,
    notes[2].id,
  ]);
});
it("keeps accepted historical changes visible under their topic after a source edit, without approving stale classification", () => {
  const topic = randomUUID(),
    a = randomUUID(),
    b = randomUUID();
  const notes = [
    { id: a, version: 2 },
    { id: b, version: 1 },
  ] as Note[];
  const accepted = {
    id: randomUUID(),
    status: "accepted",
    topicId: null,
    before: { id: a },
    after: { id: b },
    outdated: true,
  };
  const state = {
    topics: [{ id: topic, confirmed: true }],
    memberships: [a, b].map((sourceId) => ({
      topicId: topic,
      sourceKind: "note",
      sourceId,
      sourceVersion: "1",
      status: "accepted",
    })),
    events: [],
    candidates: [
      accepted,
      { ...accepted, id: randomUUID(), status: "pending" },
    ],
  } as unknown as ThoughtMapSnapshot;
  expect(confirmedChanges(notes, state, topic)).toEqual([accepted]);
  expect(confirmedChanges([notes[1]], state, topic)).toEqual([]);
  state.memberships[0].status = "rejected";
  expect(confirmedChanges(notes, state, topic)).toEqual([]);
  expect(confirmedChanges(notes, state, "")).toEqual([accepted]);
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
