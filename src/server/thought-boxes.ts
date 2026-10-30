import type { Database } from "./library-store";
import { LibraryError } from "./library-store";
import { WHITEBOARD_ID } from "../lib/whiteboard";
import {
  planThoughtBoxPromotion,
  sharedBoxSummaries,
} from "../lib/shared-thought-boxes";
export async function readThoughtBoxes(db: Database, owner: string) {
  if (!owner) throw new LibraryError(401, "로그인이 필요합니다.");
  const pendingLegacy = !!(
    await db.query(
      "SELECT EXISTS(SELECT 1 FROM library_whiteboards w LEFT JOIN library_research r ON r.owner_id=w.owner_id AND r.id=w.id CROSS JOIN LATERAL jsonb_array_elements(coalesce(w.data->'writing'->'chapters','[]'::jsonb)) c WHERE w.owner_id=$1 AND (w.id=$2::uuid OR r.id IS NOT NULL) AND NOT(c.value ? 'bundleId')) AS pending",
      [owner, WHITEBOARD_ID],
    )
  ).rows[0].pending;
  if (pendingLegacy) {
    const boards = (
      await db.query(
        "SELECT w.id,w.data,w.version FROM library_whiteboards w LEFT JOIN library_research r ON r.owner_id=w.owner_id AND r.id=w.id WHERE w.owner_id=$1 AND (w.id=$2::uuid OR r.id IS NOT NULL)",
        [owner, WHITEBOARD_ID],
      )
    ).rows;
    const bundles = (
      await db.query(
        "SELECT * FROM library_memo_bundles WHERE owner_id=$1 ORDER BY created_at,id",
        [owner],
      )
    ).rows;
    const plan = planThoughtBoxPromotion(boards as any, bundles as any);
    return {
      pendingLegacy,
      items: sharedBoxSummaries(plan.bundles),
      legacyConflicts: plan.conflicts,
      legacyToken: plan.legacyToken,
    };
  }
  const rows = (
    await db.query(
      "SELECT id,title,version,jsonb_array_length(note_ids)::int AS note_count FROM library_memo_bundles WHERE owner_id=$1 AND archived_at IS NULL ORDER BY created_at,id",
      [owner],
    )
  ).rows;
  return {
    pendingLegacy,
    items: rows.map((r, index) => ({
      id: r.id,
      bundleId: r.id,
      bundleVersion: r.version,
      boardId: WHITEBOARD_ID,
      chapterId: r.id,
      boardTitle: "생각묶음",
      title: r.title,
      order: index + 1,
      noteCount: r.note_count,
      boardVersion: r.version,
    })),
  };
}
