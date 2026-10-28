import type { OutboxEntry } from "../../lib/replica/contracts";
import type { QueuedChange } from "./optimistic";
const referenceFields = new Set([
  "id",
  "entityId",
  "bookId",
  "noteId",
  "researchId",
  "itemId",
  "sourceId",
  "targetId",
  "topicId",
  "parentId",
  "sourceTopicId",
  "targetTopicId",
  "book_id",
  "note_id",
  "research_id",
  "source_id",
  "target_id",
  "topic_id",
  "parent_id",
]);
function remap(value: any, from: string, to: string): any {
  if (Array.isArray(value)) return value.map((v) => remap(v, from, to));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [
      k,
      referenceFields.has(k) && v === from ? to : remap(v, from, to),
    ]),
  );
}
/** Change structured identities only; prose and request fingerprints stay intact. */
export function remapQueuedEntry(
  entry: OutboxEntry,
  from: string,
  to: string,
): OutboxEntry {
  const c = entry.command as QueuedChange;
  return {
    ...entry,
    entityId: entry.entityId === from ? to : entry.entityId,
    command: {
      ...c,
      body: remap(c.body, from, to),
      base: remap(c.base, from, to),
      result: remap(c.result, from, to),
      effects: c.effects.map((e) => ({
        ...e,
        key: JSON.stringify(
          JSON.parse(e.key).map((id: unknown) => (id === from ? to : id)),
        ),
        after: remap(e.after, from, to),
      })),
    },
  };
}
