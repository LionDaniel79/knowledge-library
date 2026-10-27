import { WHITEBOARD_ID, boardSaveSchema, emptyBoard } from "../lib/whiteboard";
import {
  noteVisibilitySchema,
  withWhiteboardNoteVisibility,
  whiteboardSaveData,
} from "../lib/whiteboard-visibility";
import { projectNote } from "../lib/replica/projections";
import { LibraryError, type Executor, type Database } from "./library-store";
import { randomUUID } from "node:crypto";
export async function saveWhiteboard(
  tx: Executor,
  owner: string,
  input: unknown,
) {
  const p = boardSaveSchema.parse(input);
  if (
    !(
      await tx.query("SELECT to_regclass('public.library_whiteboards') AS name")
    ).rows[0]?.name
  )
    throw new LibraryError(
      503,
      "화이트보드 온라인 저장 구조가 아직 준비되지 않았습니다.",
    );
  const before = (
    await tx.query(
      "SELECT * FROM library_whiteboards WHERE owner_id=$1 AND id=$2 FOR UPDATE",
      [owner, WHITEBOARD_ID],
    )
  ).rows[0];
  if ((before?.version ?? 0) !== p.expectedVersion)
    throw new LibraryError(
      409,
      "화이트보드가 다른 곳에서 변경됐습니다. 현재 배치는 유지됩니다. 최신 보드와 비교해 주세요.",
    );
  // Ordinary layout saves and undo cannot change note visibility. Only its
  // dedicated command or a reviewed conflict replacement includes that setting.
  const data = whiteboardSaveData(p.data, before?.data, p.includeVisibility);
  const after = before
    ? (
        await tx.query(
          "UPDATE library_whiteboards SET data=$3,version=version+1,updated_at=now() WHERE owner_id=$1 AND id=$2 RETURNING *",
          [owner, WHITEBOARD_ID, JSON.stringify(data)],
        )
      ).rows[0]
    : (
        await tx.query(
          "INSERT INTO library_whiteboards(owner_id,id,data) VALUES($1,$2,$3) RETURNING *",
          [owner, WHITEBOARD_ID, JSON.stringify(data)],
        )
      ).rows[0];
  await tx.query(
    "INSERT INTO library_revisions(id,owner_id,entity_id,action,before_data,after_data) VALUES($1,$2,$3,'saveWhiteboard',$4,$5)",
    [
      randomUUID(),
      owner,
      WHITEBOARD_ID,
      before ? JSON.stringify(before) : null,
      JSON.stringify(after),
    ],
  );
  return { id: WHITEBOARD_ID, version: after.version };
}
export async function setWhiteboardNoteVisibility(
  tx: Executor,
  owner: string,
  input: unknown,
) {
  const p = noteVisibilitySchema.parse(input);
  const before = (
    await tx.query(
      "SELECT id,data,version FROM library_whiteboards WHERE owner_id=$1 AND id=$2 FOR UPDATE",
      [owner, WHITEBOARD_ID],
    )
  ).rows[0];
  const original = before?.data ?? emptyBoard(),
    data = withWhiteboardNoteVisibility(original, p.noteId, p.visible);
  if (data === original)
    return { id: WHITEBOARD_ID, version: before?.version ?? 0 };
  return saveWhiteboard(tx, owner, {
    expectedVersion: before?.version ?? 0,
    data,
    includeVisibility: true,
  });
}
export async function readWhiteboardVisibility(
  db: Database,
  owner: string,
  noteId: string,
) {
  if (!owner) throw new LibraryError(401, "로그인이 필요합니다.");
  noteVisibilitySchema.shape.noteId.parse(noteId);
  const row = (
    await db.query(
      "SELECT NOT (COALESCE(w.data->'hiddenNoteIds','[]'::jsonb) ? $2::text) AS visible FROM library_active_notes n LEFT JOIN library_whiteboards w ON w.owner_id=n.owner_id AND w.id=$3 WHERE n.owner_id=$1 AND n.id=$2::uuid",
      [owner, noteId, WHITEBOARD_ID],
    )
  ).rows[0];
  if (!row) throw new LibraryError(404, "메모를 찾을 수 없습니다.");
  return { visible: row.visible };
}
export async function readWhiteboard(db: Database, owner: string) {
  if (!owner) throw new LibraryError(401, "로그인이 필요합니다.");
  return db.transaction(async (tx) => {
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    const notes = (
      await tx.query(
        "SELECT * FROM library_active_notes WHERE owner_id=$1 ORDER BY created_at,id",
        [owner],
      )
    ).rows.map((r) => projectNote(r));
    const books = (
      await tx.query(
        "SELECT id,title,author,category,publisher,isbn,version FROM library_active_books WHERE owner_id=$1 ORDER BY title,id",
        [owner],
      )
    ).rows;
    const topics = (
      await tx.query(
        "SELECT id,name,version FROM library_topics WHERE owner_id=$1 AND archived_at IS NULL ORDER BY name,id",
        [owner],
      )
    ).rows;
    const memberships = (
      await tx.query(
        "SELECT topic_id,source_kind,source_id,status FROM library_topic_memberships WHERE owner_id=$1",
        [owner],
      )
    ).rows.map((m) => ({
      topicId: m.topic_id,
      sourceKind: m.source_kind,
      sourceId: m.source_id,
      status: m.status,
    }));
    const ids = new Set(notes.map((n) => n.id));
    const connections = (
      await tx.query(
        "SELECT id,source_kind,source_id,target_kind,target_id,relation,reason,status,version FROM library_connections WHERE owner_id=$1 AND source_kind='note' AND target_kind='note'",
        [owner],
      )
    ).rows.filter((c) => ids.has(c.source_id) && ids.has(c.target_id));
    const ready = (
      await tx.query("SELECT to_regclass('public.library_whiteboards') AS name")
    ).rows[0]?.name;
    const row = ready
      ? (
          await tx.query(
            "SELECT id,data,version FROM library_whiteboards WHERE owner_id=$1 AND id=$2",
            [owner, WHITEBOARD_ID],
          )
        ).rows[0]
      : null;
    return {
      board: row ?? null,
      notes,
      books,
      topics,
      memberships,
      connections,
      topicLinks: (
        await tx.query(
          "SELECT id,source_topic_id,target_topic_id,status FROM library_topic_links WHERE owner_id=$1 AND status='accepted'",
          [owner],
        )
      ).rows.map((r) => ({
        id: r.id,
        sourceTopicId: r.source_topic_id,
        targetTopicId: r.target_topic_id,
        status: r.status,
      })),
    };
  });
}
