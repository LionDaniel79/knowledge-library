import { LibraryError, type Executor } from "./library-store";
import { noteContextId, type NoteContext } from "../lib/note-context";
export async function writeNoteContext(
  tx: Executor,
  owner: string,
  noteId: string,
  noteVersion: number,
  p: NoteContext,
  requestId: string,
) {
  const revise = async (
    kind: string,
    index: number,
    entity: string,
    before: unknown,
    after: unknown,
  ) =>
    tx.query(
      "INSERT INTO library_revisions(id,owner_id,entity_id,action,before_data,after_data) VALUES($1,$2,$3,$4,$5,$6)",
      [
        noteContextId(requestId, `revision-${kind}`, index),
        owner,
        entity,
        kind === "topic" ? "assignTopic" : "connectRelatedNote",
        before ? JSON.stringify(before) : null,
        JSON.stringify(after),
      ],
    );
  for (const [i, change] of (p.topicChanges ?? []).entries()) {
    const topic = (
      await tx.query(
        "SELECT id,archived_at FROM library_topics WHERE owner_id=$1 AND id=$2 FOR SHARE",
        [owner, change.topicId],
      )
    ).rows[0];
    if (!topic) throw new LibraryError(404, "주제를 찾을 수 없습니다.");
    if (topic.archived_at && change.status === "accepted")
      throw new LibraryError(
        409,
        "삭제한 주제입니다. 주제를 다시 선택해 주세요.",
      );
    const before = (
      await tx.query(
        "SELECT * FROM library_topic_memberships WHERE owner_id=$1 AND topic_id=$2 AND source_kind='note' AND source_id=$3",
        [owner, change.topicId, noteId],
      )
    ).rows[0];
    if ((before?.version ?? 0) !== change.expectedVersion)
      throw new LibraryError(
        409,
        "주제 분류가 변경되었습니다. 기록 내용은 유지됩니다. 다시 확인해 주세요.",
      );
    const after = (
      await tx.query(
        "INSERT INTO library_topic_memberships(id,owner_id,topic_id,source_kind,source_id,source_version,status,method) VALUES($1,$2,$3,'note',$4,$5,$6,'manual') ON CONFLICT(owner_id,topic_id,source_kind,source_id) DO UPDATE SET source_version=excluded.source_version,status=excluded.status,method='manual',version=library_topic_memberships.version+1 RETURNING *",
        [
          before?.id ?? noteContextId(requestId, "topic", i),
          owner,
          change.topicId,
          noteId,
          String(noteVersion),
          change.status,
        ],
      )
    ).rows[0];
    await revise("topic", i, after.id, before, after);
  }
  for (const [i, related] of (p.relatedNotes ?? []).entries()) {
    if (related.noteId === noteId)
      throw new LibraryError(400, "같은 기록을 자신에게 연결할 수 없습니다.");
    const source = (
      await tx.query(
        "SELECT n.id FROM library_notes n WHERE n.owner_id=$1 AND n.id=$2 AND NOT EXISTS (SELECT 1 FROM library_note_trash t WHERE t.owner_id=n.owner_id AND t.id=n.id AND t.restored_at IS NULL) FOR SHARE OF n",
        [owner, related.noteId],
      )
    ).rows[0];
    if (!source) throw new LibraryError(404, "연결할 기록을 찾을 수 없습니다.");
    const [a, b] = [noteId, related.noteId].sort();
    const before = (
      await tx.query(
        "SELECT * FROM library_connections WHERE owner_id=$1 AND source_kind='note' AND target_kind='note' AND ((source_id=$2 AND target_id=$3) OR (source_id=$3 AND target_id=$2)) ORDER BY (status='accepted') DESC,created_at,id LIMIT 1 FOR UPDATE",
        [owner, a, b],
      )
    ).rows[0];
    if (before?.status === "accepted") continue;
    const after = before
      ? (
          await tx.query(
            "UPDATE library_connections SET status='accepted',relation='related',reason='관련 기록으로 직접 연결',method='manual',version=version+1 WHERE owner_id=$1 AND id=$2 RETURNING *",
            [owner, before.id],
          )
        ).rows[0]
      : (
          await tx.query(
            "INSERT INTO library_connections(id,owner_id,source_kind,source_id,target_kind,target_id,relation,status,reason,method) VALUES($1,$2,'note',$3,'note',$4,'related','accepted','관련 기록으로 직접 연결','manual') RETURNING *",
            [noteContextId(requestId, "link", i), owner, a, b],
          )
        ).rows[0];
    await revise("link", i, after.id, before, after);
  }
}
export async function readNoteTopics(
  tx: Executor,
  owner: string,
  noteId?: string,
) {
  if (!owner) throw new LibraryError(401, "로그인이 필요합니다.");
  if (
    noteId &&
    !(
      await tx.query(
        "SELECT id FROM library_active_notes WHERE owner_id=$1 AND id=$2",
        [owner, noteId],
      )
    ).rows.length
  )
    throw new LibraryError(404, "기록을 찾을 수 없습니다.");
  const rows = (
    await tx.query(
      "SELECT * FROM library_topics WHERE owner_id=$1 AND archived_at IS NULL ORDER BY name,id",
      [owner],
    )
  ).rows;
  const topics = rows.map((t) => ({
    id: t.id,
    name: t.name,
    parentId: t.parent_id,
    aliases: t.aliases,
    description: t.description,
    kdcCodes: t.kdc_codes,
    confirmed: t.confirmed,
    version: t.version,
  }));
  const ms = noteId
    ? (
        await tx.query(
          "SELECT m.* FROM library_topic_memberships m JOIN library_topics t ON t.owner_id=m.owner_id AND t.id=m.topic_id AND t.archived_at IS NULL WHERE m.owner_id=$1 AND m.source_kind='note' AND m.source_id=$2",
          [owner, noteId],
        )
      ).rows
    : [];
  return {
    topics,
    memberships: ms.map((m) => ({
      id: m.id,
      topicId: m.topic_id,
      sourceKind: m.source_kind,
      sourceId: m.source_id,
      sourceVersion: m.source_version,
      status: m.status,
      method: m.method,
      evidence: m.evidence,
      version: m.version,
    })),
  };
}
