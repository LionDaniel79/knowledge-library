import { WHITEBOARD_ID, boardSaveSchema, emptyBoard } from "../lib/whiteboard";
import {
  noteVisibilitySchema,
  notesVisibilitySchema,
  withWhiteboardNotesVisibility,
  whiteboardSaveData,
} from "../lib/whiteboard-visibility";
import { projectNote } from "../lib/replica/projections";
import { LibraryError, type Executor, type Database } from "./library-store";
import { randomUUID } from "node:crypto";
async function requireBoard(tx: Executor, owner: string, boardId: string) {
  boardSaveSchema.shape.boardId.parse(boardId);
  if (
    boardId !== WHITEBOARD_ID &&
    !(
      await tx.query(
        "SELECT id FROM library_research WHERE owner_id=$1 AND id=$2 FOR KEY SHARE",
        [owner, boardId],
      )
    ).rows.length
  )
    throw new LibraryError(404, "글감 묶음을 찾을 수 없습니다.");
}
export async function readWhiteboardSummary(
  db: Database,
  owner: string,
  boardId = WHITEBOARD_ID,
) {
  if (!owner) throw new LibraryError(401, "로그인이 필요합니다.");
  await requireBoard(db, owner, boardId);
  const row = (
    await db.query(
      "SELECT version FROM library_whiteboards WHERE owner_id=$1 AND id=$2",
      [owner, boardId],
    )
  ).rows[0];
  return { id: boardId, version: row?.version ?? 0 };
}
export async function saveWhiteboard(
  tx: Executor,
  owner: string,
  input: unknown,
) {
  const p = boardSaveSchema.parse(input),
    boardId = p.boardId ?? WHITEBOARD_ID;
  await requireBoard(tx, owner, boardId);
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
      [owner, boardId],
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
          [owner, boardId, JSON.stringify(data)],
        )
      ).rows[0]
    : (
        await tx.query(
          "INSERT INTO library_whiteboards(owner_id,id,data) VALUES($1,$2,$3) RETURNING *",
          [owner, boardId, JSON.stringify(data)],
        )
      ).rows[0];
  await tx.query(
    "INSERT INTO library_revisions(id,owner_id,entity_id,action,before_data,after_data) VALUES($1,$2,$3,'saveWhiteboard',$4,$5)",
    [
      randomUUID(),
      owner,
      boardId,
      before ? JSON.stringify(before) : null,
      JSON.stringify(after),
    ],
  );
  return { id: boardId, version: after.version };
}
export async function setWhiteboardNoteVisibility(
  tx: Executor,
  owner: string,
  input: unknown,
) {
  const p = noteVisibilitySchema.parse(input);
  return setVisibility(tx, owner, [p.noteId], p.visible, p.boardId);
}
export async function setWhiteboardNotesVisibility(
  tx: Executor,
  owner: string,
  input: unknown,
) {
  const p = notesVisibilitySchema.parse(input);
  const owned = (
    await tx.query(
      "SELECT id FROM library_active_notes WHERE owner_id=$1 AND id=ANY($2::uuid[])",
      [owner, p.noteIds],
    )
  ).rows;
  if (owned.length !== p.noteIds.length)
    throw new LibraryError(404, "메모를 찾을 수 없습니다.");
  return setVisibility(tx, owner, p.noteIds, p.visible, p.boardId);
}
async function setVisibility(
  tx: Executor,
  owner: string,
  noteIds: string[],
  visible: boolean,
  boardId = WHITEBOARD_ID,
) {
  await requireBoard(tx, owner, boardId);
  const before = (
    await tx.query(
      "SELECT id,data,version FROM library_whiteboards WHERE owner_id=$1 AND id=$2 FOR UPDATE",
      [owner, boardId],
    )
  ).rows[0];
  const original = before?.data ?? emptyBoard(),
    data = withWhiteboardNotesVisibility(original, noteIds, visible);
  if (data === original) return { id: boardId, version: before?.version ?? 0 };
  return saveWhiteboard(tx, owner, {
    boardId,
    expectedVersion: before?.version ?? 0,
    data,
    includeVisibility: true,
  });
}
export async function readWhiteboardVisibility(
  db: Database,
  owner: string,
  noteId: string,
  boardId = WHITEBOARD_ID,
) {
  if (!owner) throw new LibraryError(401, "로그인이 필요합니다.");
  noteVisibilitySchema.shape.noteId.parse(noteId);
  await requireBoard(db, owner, boardId);
  const row = (
    await db.query(
      "SELECT NOT (COALESCE(w.data->'hiddenNoteIds','[]'::jsonb) ? $2::text) AS visible FROM library_active_notes n LEFT JOIN library_whiteboards w ON w.owner_id=n.owner_id AND w.id=$3 WHERE n.owner_id=$1 AND n.id=$2::uuid",
      [owner, noteId, boardId],
    )
  ).rows[0];
  if (!row) throw new LibraryError(404, "메모를 찾을 수 없습니다.");
  return { visible: row.visible };
}
export async function readWhiteboard(
  db: Database,
  owner: string,
  boardId = WHITEBOARD_ID,
) {
  if (!owner) throw new LibraryError(401, "로그인이 필요합니다.");
  return db.transaction(async (tx) => {
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await requireBoard(tx, owner, boardId);
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
        "SELECT id,source_kind,source_id,target_kind,target_id,relation,reason,status,version,title FROM library_connections WHERE owner_id=$1 AND source_kind='note' AND target_kind='note'",
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
            [owner, boardId],
          )
        ).rows[0]
      : null;
    const bundles = (
      await tx.query(
        "SELECT id,title,description,note_ids,version,archived_at,created_at,updated_at FROM library_memo_bundles WHERE owner_id=$1 ORDER BY created_at,id",
        [owner],
      )
    ).rows;
    const bundleLinks = (
      await tx.query(
        "SELECT id,source_id,target_id,relation,reason,status,version FROM library_bundle_links WHERE owner_id=$1",
        [owner],
      )
    ).rows;
    return {
      bundles,
      bundleLinks,
      board: row ?? null,
      notes,
      books,
      topics,
      memberships,
      connections,
      topicLinks: (
        await tx.query(
          "SELECT id,source_topic_id,target_topic_id,status,version FROM library_topic_links WHERE owner_id=$1 AND status='accepted'",
          [owner],
        )
      ).rows.map((r) => ({
        id: r.id,
        sourceTopicId: r.source_topic_id,
        targetTopicId: r.target_topic_id,
        status: r.status,
        version: r.version,
      })),
    };
  });
}
