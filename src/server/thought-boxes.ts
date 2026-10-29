import type { Database } from "./library-store";
import { LibraryError } from "./library-store";
import { WHITEBOARD_ID } from "../lib/whiteboard";
import type { ThoughtBoxSummary } from "../lib/thought-boxes";
export async function readThoughtBoxes(
  db: Database,
  owner: string,
): Promise<{ items: ThoughtBoxSummary[] }> {
  if (!owner) throw new LibraryError(401, "로그인이 필요합니다.");
  const rows = (
    await db.query(
      `SELECT w.id::text AS board_id,w.version AS board_version,coalesce(r.title,'화이트보드') AS board_title,
 c.value->>'id' AS chapter_id,c.value->>'title' AS title,(c.value->>'order')::int AS position,
 (SELECT count(DISTINCT n.value #>> '{}')::int FROM jsonb_array_elements(c.value->'items') i CROSS JOIN LATERAL jsonb_array_elements(i.value->'noteIds') n) AS note_count
 FROM library_whiteboards w LEFT JOIN library_research r ON r.owner_id=w.owner_id AND r.id=w.id
 CROSS JOIN LATERAL jsonb_array_elements(coalesce(w.data->'writing'->'chapters','[]'::jsonb)) c
 WHERE w.owner_id=$1 AND (w.id=$2::uuid OR r.id IS NOT NULL)
 ORDER BY board_title,position,chapter_id`,
      [owner, WHITEBOARD_ID],
    )
  ).rows;
  return {
    items: rows.map((r) => ({
      id: r.board_id + ":" + r.chapter_id,
      boardId: r.board_id,
      chapterId: r.chapter_id,
      boardTitle: r.board_title,
      title: r.title,
      order: Number(r.position),
      noteCount: Number(r.note_count),
      boardVersion: Number(r.board_version),
    })),
  };
}
