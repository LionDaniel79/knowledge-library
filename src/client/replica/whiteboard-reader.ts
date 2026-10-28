import type { ReplicaStorage } from "./storage";
import type { SyncEntity } from "../../lib/replica/entities";
import type { RawRecord } from "../../lib/replica/projections";
import { projectNote } from "../../lib/replica/projections";
import {
  WHITEBOARD_ID,
  boardSaveSchema,
  type WhiteboardSnapshot,
} from "../../lib/whiteboard";
import { ReplicaQueryError } from "./queries";
const sources: SyncEntity[] = [
  "library_notes",
  "library_note_trash",
  "library_books",
  "library_book_exclusions",
  "library_topics",
  "library_topic_memberships",
  "library_connections",
  "library_topic_links",
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
  return async (boardId = WHITEBOARD_ID) => {
    boardSaveSchema.shape.boardId.parse(boardId);
    if (
      boardId !== WHITEBOARD_ID &&
      !(await reader.raw("library_research", boardId))
    )
      throw new ReplicaQueryError(404, "글감 묶음을 찾을 수 없습니다.");
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
                publisher: b.publisher,
                isbn: b.isbn,
                version: b.version,
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
            topicLinks: (await reader.all("library_topic_links"))
              .filter((l) => l.status === "accepted")
              .map((l) => ({
                id: l.id,
                sourceTopicId: l.source_topic_id,
                targetTopicId: l.target_topic_id,
                status: l.status,
                version: l.version,
              })),
          },
        };
      }
      const resolved =
        (await storage.listConflicts(true))
          .filter((c) => c.entityId === boardId && c.resolvedAt)
          .map((c) => `${c.resolvedAt}:${c.requestId}`)
          .sort()
          .at(-1) ?? "";
      const row = await reader.raw("library_whiteboards", boardId);
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
