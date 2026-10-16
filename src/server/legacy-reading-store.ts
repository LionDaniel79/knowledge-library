import { createHash, randomUUID } from "node:crypto";
import { LibraryError, type Database } from "./library-store";
import { mapLegacyReading } from "../lib/legacy-reading";
import type { Book } from "../lib/domain";

export function createLegacyReadingStore(db: Database) {
  async function run(owner: string, apply = false) {
    if (!owner) throw new LibraryError(401, "로그인이 필요합니다.");
    // Only legacy fields are needed; fetching the full PDF catalog wastes cloud egress.
    const data = await db.query(
      "SELECT id,total_pages AS \"totalPages\",source_data AS \"sourceData\" FROM library_books WHERE owner_id=$1 AND source_data->>'app'='iReadItNow HD'",
      [owner],
    );
    const candidates = mapLegacyReading(data.rows as Book[]);
    const summary = {
      completed: candidates.filter((c) => c.status === "completed").length,
      reading: candidates.filter((c) => c.status === "reading").length,
      added: 0,
    };
    if (!apply) return summary;
    return db.transaction(async (tx) => {
      const rows = candidates.map((c) => {
        const hash = createHash("sha256")
          .update(owner + ":" + c.sourceKey)
          .digest("hex");
        return {
          ...c,
          id: `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`,
        };
      });
      const added = await tx.query(
        `INSERT INTO library_cycles(id,owner_id,book_id,status,started_on,completed_on,current_page,source_key,source_data)
        SELECT r.id,$1,r."bookId",r.status,r."startedOn",r."completedOn",r."currentPage",r."sourceKey",r."sourceData"
        FROM jsonb_to_recordset($2::jsonb) AS r(id uuid,"bookId" uuid,status text,"startedOn" date,"completedOn" date,"currentPage" integer,"sourceKey" text,"sourceData" jsonb)
        WHERE (r.status<>'reading' OR NOT EXISTS(SELECT 1 FROM library_cycles c WHERE c.owner_id=$1 AND c.book_id=r."bookId" AND c.status='reading'))
        ON CONFLICT(owner_id,source_key) DO NOTHING RETURNING *`,
        [owner, JSON.stringify(rows)],
      );
      if (added.rows.length)
        await tx.query(
          `INSERT INTO library_revisions(id,owner_id,entity_id,action,after_data)
        SELECT r.id,$1,r."entityId",'importReadingHistory',r.data FROM jsonb_to_recordset($2::jsonb) AS r(id uuid,"entityId" uuid,data jsonb)`,
          [
            owner,
            JSON.stringify(
              added.rows.map((r) => ({
                id: randomUUID(),
                entityId: r.id,
                data: r,
              })),
            ),
          ],
        );
      return { ...summary, added: added.rows.length };
    });
  }
  return { run };
}
