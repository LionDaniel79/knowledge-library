import { LibraryError, type Executor } from "./library-store";
import { dto } from "./thought-map-store";
import {
  resolveThoughtRecord,
  noteFromRow,
  withEvent,
} from "../lib/thought-map/records";
import type { SourcePage, SourcePageRequest } from "../lib/thought-map/jobs";
// All arrays, including taxonomy and book/document mappings, use keyset pages.
// Candidate bodies are not needed by the worker. Only decisions for its anchor are synchronized.
export async function readSourcePage(
  db: Executor,
  owner: string,
  anchorId: string,
  request: SourcePageRequest,
): Promise<SourcePage> {
  const after = request.after ?? "00000000-0000-0000-0000-000000000000";
  const params = [owner, after, anchorId];
  const sql: Record<SourcePageRequest["kind"], string> = {
    notes: `SELECT n.*,to_jsonb(e) AS event FROM library_active_notes n LEFT JOIN library_thought_events e ON e.owner_id=n.owner_id AND e.note_id=n.id WHERE n.owner_id=$1 AND n.id>$2::uuid AND $3::uuid IS NOT NULL ORDER BY n.id LIMIT 50`,
    books: `SELECT b.id,b.title,b.author,b.publisher,b.version,b.tags,coalesce((SELECT jsonb_agg(d.id ORDER BY d.id) FROM library_documents d WHERE d.owner_id=b.owner_id AND d.book_id=b.id),'[]') AS documents,coalesce((SELECT jsonb_agg(m.topic_id ORDER BY m.topic_id) FROM library_topic_memberships m WHERE m.owner_id=b.owner_id AND m.source_kind='book' AND m.source_id=b.id::text AND m.status='accepted'),'[]') AS topics FROM library_books b WHERE b.owner_id=$1 AND b.id>$2::uuid AND $3::uuid IS NOT NULL ORDER BY b.id LIMIT 50`,
    topics: `SELECT * FROM library_topics WHERE owner_id=$1 AND id>$2::uuid AND $3::uuid IS NOT NULL ORDER BY id LIMIT 50`,
    memberships: `SELECT * FROM library_topic_memberships WHERE owner_id=$1 AND id>$2::uuid AND source_kind='note' AND $3::uuid IS NOT NULL ORDER BY id LIMIT 50`,
    topicLinks: `SELECT * FROM library_topic_links WHERE owner_id=$1 AND id>$2::uuid AND $3::uuid IS NOT NULL ORDER BY id LIMIT 50`,
    feedback: `SELECT f.* FROM library_analysis_feedback f JOIN library_evolution_candidates c ON c.owner_id=f.owner_id AND c.id=f.candidate_id WHERE f.owner_id=$1 AND f.id>$2::uuid AND (c.before_id=$3 OR c.after_id=$3) ORDER BY f.id LIMIT 50`,
    candidates: `SELECT id,status,before_id,after_id FROM library_evolution_candidates WHERE owner_id=$1 AND id>$2::uuid AND (before_id=$3 OR after_id=$3) ORDER BY id LIMIT 50`,
  };
  const limit = request.kind === "books" ? 500 : 50;
  const rows = (
    await db.query(
      sql[request.kind].replace("LIMIT 50", `LIMIT ${limit}`),
      params,
    )
  ).rows;
  const items: any[] = [];
  let bytes = 100,
    last: string | null = null;
  for (const row of rows) {
    const item =
      request.kind === "notes"
        ? withEvent(
            resolveThoughtRecord(noteFromRow(row)),
            row.event ? dto(row.event) : undefined,
          )
        : request.kind === "books"
          ? {
              id: row.id,
              rootId: row.id,
              version: String(row.version),
              text: [
                row.title,
                row.author,
                row.publisher,
                ...(row.tags ?? []),
              ].join(" "),
              documentIds: row.documents,
              topicIds: row.topics,
            }
          : request.kind === "candidates"
            ? {
                id: row.id,
                status: row.status,
                before: { id: row.before_id },
                after: { id: row.after_id },
              }
            : dto(row);
    const size = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (bytes + size > 450 * 1024) {
      if (!items.length)
        throw new LibraryError(
          413,
          "한 자료가 분석 전송 한도를 초과했습니다. 기록을 나누어 주세요.",
        );
      return { kind: request.kind, items, next: last };
    }
    items.push(item);
    bytes += size;
    last = row.id;
  }
  return {
    kind: request.kind,
    items,
    next: rows.length === limit ? last : null,
  };
}
