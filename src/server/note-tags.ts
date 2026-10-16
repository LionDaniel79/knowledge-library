import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { type Database, LibraryError } from "./library-store";
const fingerprint = (rows: Record<string, any>[]) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        rows
          .map((r) => [r.id, r.version])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      ),
    )
    .digest("hex");
const input = z.object({
  tag: z.string().trim().min(1).max(40),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  requestId: z.string().uuid(),
});
function requireOwner(owner: string) {
  if (!owner) throw new LibraryError(401, "로그인이 필요합니다.");
}
export function createNoteTagStore(db: Database) {
  return {
    async list(owner: string) {
      requireOwner(owner);
      const rows = (
        await db.query(
          `SELECT n.id,n.version,n.tags,NOT EXISTS(SELECT 1 FROM library_note_trash t WHERE t.owner_id=n.owner_id AND t.id=n.id AND t.restored_at IS NULL) AS active FROM library_notes n WHERE n.owner_id=$1 ORDER BY n.id`,
          [owner],
        )
      ).rows;
      const groups = new Map<string, typeof rows>();
      for (const row of rows)
        for (const tag of row.tags ?? [])
          groups.set(tag, [...(groups.get(tag) ?? []), row]);
      return [...groups]
        .sort(([a], [b]) => a.localeCompare(b, "ko"))
        .map(([tag, notes]) => ({
          tag,
          count: notes.length,
          activeCount: notes.filter((n) => n.active).length,
          fingerprint: fingerprint(notes),
        }));
    },
    async remove(owner: string, raw: unknown) {
      requireOwner(owner);
      const command = input.parse(raw);
      return db.transaction(async (tx) => {
        const opHash = createHash("sha256")
          .update(
            JSON.stringify(["removeNoteTag", command.tag, command.fingerprint]),
          )
          .digest("hex");
        const claimed = await tx.query(
          "INSERT INTO library_operations(owner_id,request_id,fingerprint) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING request_id",
          [owner, command.requestId, opHash],
        );
        if (!claimed.rows.length) {
          const previous = (
            await tx.query(
              "SELECT fingerprint,result FROM library_operations WHERE owner_id=$1 AND request_id=$2",
              [owner, command.requestId],
            )
          ).rows[0];
          if (previous?.fingerprint !== opHash || !previous.result)
            throw new LibraryError(
              409,
              "요청이 변경되었습니다. 다시 시도해 주세요.",
            );
          return previous.result as { removed: number };
        }
        const rows = (
          await tx.query(
            "SELECT * FROM library_notes WHERE owner_id=$1 AND $2=ANY(tags) ORDER BY id FOR UPDATE",
            [owner, command.tag],
          )
        ).rows;
        if (fingerprint(rows) !== command.fingerprint)
          throw new LibraryError(
            409,
            "기록이 변경되었습니다. 태그 목록을 새로 열어 주세요.",
          );
        for (const before of rows) {
          const after = (
            await tx.query(
              "UPDATE library_notes SET tags=array_remove(tags,$3),version=version+1,updated_at=now() WHERE owner_id=$1 AND id=$2 RETURNING *",
              [owner, before.id, command.tag],
            )
          ).rows[0];
          await tx.query(
            "INSERT INTO library_revisions(id,owner_id,entity_id,action,before_data,after_data) VALUES($1,$2,$3,'removeNoteTag',$4,$5)",
            [
              randomUUID(),
              owner,
              before.id,
              JSON.stringify(before),
              JSON.stringify(after),
            ],
          );
        }
        const result = { removed: rows.length };
        await tx.query(
          "UPDATE library_operations SET result=$3 WHERE owner_id=$1 AND request_id=$2",
          [owner, command.requestId, JSON.stringify(result)],
        );
        return result;
      });
    },
  };
}
