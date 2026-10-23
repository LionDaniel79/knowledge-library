import type { ReplicaStorage } from "./storage";
import type { SyncEntity } from "../../lib/replica/entities";
import type { RawRecord } from "../../lib/replica/projections";
import { projectNote } from "../../lib/replica/projections";
import { WHITEBOARD_ID, type WhiteboardSnapshot } from "../../lib/whiteboard";
const sources: SyncEntity[] = [
  "library_notes",
  "library_note_trash",
  "library_books",
  "library_book_exclusions",
  "library_topics",
  "library_topic_memberships",
  "library_connections",
];
export function createWhiteboardReader(
  storage: ReplicaStorage,
  reader: {
    raw(e: SyncEntity, id: string): Promise<RawRecord | undefined>;
    all(e: SyncEntity): Promise<RawRecord[]>;
  },
) {
  let cached:
    { token: string; value: Omit<WhiteboardSnapshot, "board"> } | undefined;
  return async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const cp = await storage.checkpoint();
      const checkpointStamp = JSON.stringify(cp);
      const token = JSON.stringify([
        cp?.generation,
        ...sources.map((e) => [
          cp?.entityRevisions?.[e],
          cp?.localEntityRevisions?.[e],
          cp?.entityWrites?.[e],
        ]),
      ]);
      if (cached?.token !== token) {
        const trash = new Set(
            (await reader.all("library_note_trash"))
              .filter((r) => r.restored_at === null)
              .map((r) => r.id),
          ),
          excluded = new Set(
            (await reader.all("library_book_exclusions"))
              .filter((r) => r.state === "excluded")
              .map((r) => r.id),
          );
        const notes = (await reader.all("library_notes"))
            .filter((n) => !trash.has(n.id))
            .map((n) => projectNote(n)),
          ids = new Set(notes.map((n) => n.id));
        cached = {
          token,
          value: {
            notes,
            books: (await reader.all("library_books"))
              .filter((b) => !excluded.has(b.id))
              .map((b) => ({
                id: b.id,
                title: b.title,
                author: b.author,
                category: b.category,
              })),
            topics: (await reader.all("library_topics"))
              .filter((t) => !t.archived_at)
              .map((t) => ({ id: t.id, name: t.name, version: t.version })),
            memberships: (await reader.all("library_topic_memberships")).map(
              (m) => ({
                topicId: m.topic_id,
                sourceKind: m.source_kind,
                sourceId: m.source_id,
                status: m.status,
              }),
            ),
            connections: (await reader.all("library_connections")).filter(
              (c) =>
                c.source_kind === "note" &&
                c.target_kind === "note" &&
                ids.has(c.source_id) &&
                ids.has(c.target_id),
            ) as WhiteboardSnapshot["connections"],
          },
        };
      }
      const resolved =
        (await storage.listConflicts(true))
          .filter((c) => c.entityId === WHITEBOARD_ID && c.resolvedAt)
          .map((c) => `${c.resolvedAt}:${c.requestId}`)
          .sort()
          .at(-1) ?? "";
      const row = await reader.raw("library_whiteboards", WHITEBOARD_ID);
      // A resolution and its replacement row must come from the same local
      // revision, including when another tab resolves between awaited reads.
      if (JSON.stringify(await storage.checkpoint()) !== checkpointStamp)
        continue;
      return {
        ...cached.value,
        board: row
          ? { id: row.id, data: row.data, version: row.version }
          : null,
        resolutionToken: `${cp?.generation ?? ""}:${resolved}`,
      } as WhiteboardSnapshot;
    }
    throw Error("기기 자료가 변경되어 다시 조회해야 합니다.");
  };
}
