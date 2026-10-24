import { z } from "zod";
import { Sha256Stream } from "./replica/codec";
import type { Topic, Membership } from "./thought-map/types";
export const topicChangeSchema = z.object({
  topicId: z.string().uuid(),
  status: z.enum(["accepted", "rejected"]),
  expectedVersion: z.number().int().nonnegative(),
});
export const noteContextFields = {
  topicChanges: z
    .array(topicChangeSchema)
    .max(50)
    .refine(
      (v) => new Set(v.map((x) => x.topicId)).size === v.length,
      "같은 주제는 한 번만 변경해 주세요.",
    )
    .optional(),
  relatedNotes: z
    .array(z.object({ noteId: z.string().uuid() }))
    .max(20)
    .refine(
      (v) => new Set(v.map((x) => x.noteId)).size === v.length,
      "같은 기록은 한 번만 연결해 주세요.",
    )
    .optional(),
};
export type NoteContext = {
  topicChanges?: z.infer<typeof topicChangeSchema>[];
  relatedNotes?: { noteId: string }[];
};
export type NewNoteContext = {
  topicIds?: string[];
  relatedNotes?: { id: string; title: string }[];
  bookId?: string;
};
export interface NoteTopicSnapshot {
  topics: Topic[];
  memberships: Membership[];
}
export function noteContextId(request: string, kind: string, index: number) {
  const hash = new Sha256Stream();
  hash.update(
    new TextEncoder().encode(`note-context:${request}:${kind}:${index}`),
  );
  const h = hash.hex();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export function topicChangesFor(selected: string[], memberships: Membership[]) {
  const chosen = new Set(selected),
    before = new Map(memberships.map((m) => [m.topicId, m]));
  return [
    ...new Set([
      ...selected,
      ...memberships
        .filter((m) => m.status === "accepted")
        .map((m) => m.topicId),
    ]),
  ].flatMap((topicId) => {
    const m = before.get(topicId),
      status = chosen.has(topicId)
        ? ("accepted" as const)
        : ("rejected" as const);
    return m?.status === status
      ? []
      : [{ topicId, status, expectedVersion: m?.version ?? 0 }];
  });
}
