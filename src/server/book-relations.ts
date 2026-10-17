import { randomUUID } from "node:crypto";
import { z } from "zod";
import { LibraryError, type Database, type Executor } from "./library-store";
import { contentHash } from "./curation-store";
const command = z.object({
  requestId: z.string().uuid(),
  leftId: z.string().uuid(),
  rightId: z.string().uuid(),
  leftVersion: z.number().int().positive(),
  rightVersion: z.number().int().positive(),
  relation: z.enum(["same_file", "same_edition", "different_edition"]),
  state: z.enum(["accepted", "withdrawn"]),
  reason: z.string().trim().min(1).max(2000),
  expectedVersion: z.number().int().nonnegative(),
});
const fileEvidence = z
  .object({
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    method: z.literal("sha256"),
    verifiedAt: z.string().datetime(),
  })
  .passthrough();
export function createBookRelationStore(
  db: Database,
  sameFile?: (a: string, b: string, tx: Executor) => Promise<unknown>,
) {
  async function mutate(owner: string, input: unknown) {
    if (!owner) throw new LibraryError(401, "로그인이 필요합니다.");
    const p = command.parse(input),
      fingerprint = contentHash(JSON.stringify(["book-relation", p]));
    if (p.leftId === p.rightId)
      throw new LibraryError(400, "서로 다른 도서를 선택해 주세요.");
    return db.transaction(async (tx) => {
      const claimed = await tx.query(
        "INSERT INTO library_operations(owner_id,request_id,fingerprint) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING request_id",
        [owner, p.requestId, fingerprint],
      );
      if (!claimed.rows.length) {
        const old = (
          await tx.query(
            "SELECT fingerprint,result FROM library_operations WHERE owner_id=$1 AND request_id=$2",
            [owner, p.requestId],
          )
        ).rows[0];
        if (old?.fingerprint !== fingerprint)
          throw new LibraryError(409, "같은 요청 번호의 내용이 다릅니다.");
        return old.result;
      }
      const ids = [p.leftId, p.rightId].sort(),
        books = (
          await tx.query(
            "SELECT id,title,author,publisher,isbn,version FROM library_active_books WHERE owner_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE",
            [owner, ids],
          )
        ).rows;
      if (books.length !== 2)
        throw new LibraryError(404, "도서를 찾을 수 없습니다.");
      if (
        books.some(
          (b) =>
            b.version !== (b.id === p.leftId ? p.leftVersion : p.rightVersion),
        )
      )
        throw new LibraryError(
          409,
          "도서 정보가 변경되었습니다. 다시 확인해 주세요.",
        );
      const old = (
        await tx.query(
          "SELECT * FROM library_book_relations WHERE owner_id=$1 AND left_id=$2 AND right_id=$3 FOR UPDATE",
          [owner, ...ids],
        )
      ).rows[0];
      if ((old?.version ?? 0) !== p.expectedVersion)
        throw new LibraryError(
          409,
          "연결이 변경되었습니다. 새로고침해 주세요.",
        );
      let file: unknown = null;
      if (p.relation === "same_file" && p.state === "accepted") {
        const checked = fileEvidence.safeParse(
          await sameFile?.(ids[0], ids[1], tx),
        );
        if (!checked.success)
          throw new LibraryError(
            409,
            "원본이 있는 PC에서 두 파일의 동일 여부를 확인해야 합니다.",
          );
        file = checked.data;
      }
      const evidence =
        p.state === "withdrawn" && old
          ? old.evidence
          : { books, file, confirmedAt: new Date().toISOString() };
      const row = (
        await tx.query(
          "INSERT INTO library_book_relations(id,owner_id,left_id,right_id,relation,state,reason,evidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(owner_id,left_id,right_id) DO UPDATE SET relation=excluded.relation,state=excluded.state,reason=excluded.reason,evidence=excluded.evidence,version=library_book_relations.version+1 RETURNING *",
          [
            old?.id ?? randomUUID(),
            owner,
            ...ids,
            p.relation,
            p.state,
            p.reason,
            JSON.stringify(evidence),
          ],
        )
      ).rows[0];
      await tx.query(
        "INSERT INTO library_revisions(id,owner_id,entity_id,action,before_data,after_data) VALUES($1,$2,$3,'bookRelation',$4,$5)",
        [
          randomUUID(),
          owner,
          row.id,
          old ? JSON.stringify(old) : null,
          JSON.stringify(row),
        ],
      );
      const result = { id: row.id, version: row.version };
      await tx.query(
        "UPDATE library_operations SET result=$3 WHERE owner_id=$1 AND request_id=$2",
        [owner, p.requestId, JSON.stringify(result)],
      );
      return result;
    });
  }
  async function list(owner: string, id: string) {
    if (!owner) throw new LibraryError(401, "로그인이 필요합니다.");
    z.string().uuid().parse(id);
    const rows = (
      await db.query(
        "SELECT r.*,a.title AS left_title,b.title AS right_title,a.version AS left_version,b.version AS right_version FROM library_book_relations r JOIN library_active_books a ON a.owner_id=r.owner_id AND a.id=r.left_id JOIN library_active_books b ON b.owner_id=r.owner_id AND b.id=r.right_id WHERE r.owner_id=$1 AND (r.left_id=$2 OR r.right_id=$2) ORDER BY r.created_at,r.id",
        [owner, id],
      )
    ).rows;
    return Promise.all(
      rows.map(async (row) => {
        type Freshness = "current" | "stale" | "unavailable" | "not_applicable";
        let freshness: Freshness = "current";
        const books = Array.isArray(row.evidence?.books)
          ? row.evidence.books
          : [];
        if (row.state !== "accepted") freshness = "not_applicable";
        else if (
          [
            { id: row.left_id, version: row.left_version },
            { id: row.right_id, version: row.right_version },
          ].some(
            (b) =>
              books.find((old: any) => old.id === b.id)?.version !== b.version,
          )
        )
          freshness = "stale";
        else if (row.relation === "same_file") {
          const stored = row.evidence?.file;
          const snapshots = Array.isArray(stored?.documents)
            ? stored.documents
            : [];
          if (snapshots.length !== 2) freshness = "unavailable";
          else {
            const current = (
              await db.query(
                "SELECT id,book_id,bytes,mtime_ns FROM library_documents WHERE owner_id=$1 AND book_id=ANY($2::uuid[])",
                [owner, [row.left_id, row.right_id]],
              )
            ).rows;
            if (
              snapshots.some(
                (d: any) =>
                  !current.some(
                    (c) =>
                      c.id === d.id &&
                      `${c.bytes}:${c.mtime_ns}` === d.signature,
                  ),
              )
            )
              freshness = "stale";
            else {
              const checked = fileEvidence.safeParse(
                await sameFile?.(row.left_id, row.right_id, db),
              );
              if (!checked.success) freshness = "unavailable";
              else {
                const docs = Array.isArray(checked.data.documents)
                  ? (checked.data.documents as {
                      id: string;
                      signature: string;
                    }[])
                  : [];
                if (
                  checked.data.sha256 !== stored.sha256 ||
                  snapshots.some(
                    (d: any) =>
                      !docs.some(
                        (c) => c.id === d.id && c.signature === d.signature,
                      ),
                  )
                )
                  freshness = "stale";
              }
            }
          }
        }
        return { ...row, freshness } as Record<string, any> & {
          freshness: Freshness;
        };
      }),
    );
  }
  return { mutate, list };
}
