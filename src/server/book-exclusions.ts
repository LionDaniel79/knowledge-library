import { withSyncWrite } from "./sync/write";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { LibraryError, type Database, type Executor } from "./library-store";
const selection = z
  .object({
    id: z.string().uuid(),
    expectedVersion: z.number().int().positive(),
    kind: z.enum(["paper", "periodical"]),
  })
  .strict();
const excludeInput = z
  .object({
    requestId: z.string().uuid(),
    items: z.array(selection).min(1).max(10000),
  })
  .strict();
const restoreInput = z
  .object({
    requestId: z.string().uuid(),
    id: z.string().uuid(),
    expectedVersion: z.number().int().positive(),
  })
  .strict();
export interface BookExclusionPage {
  total: number;
  items: {
    id: string;
    title: string;
    author: string;
    kind: "paper" | "periodical";
    reason: string;
    relativePath: string;
    excludedAt: string;
    version: number;
  }[];
}
function ownerRequired(owner: string) {
  if (!owner) throw new LibraryError(401, "로그인이 필요합니다.");
}
async function operation<T>(
  db: Database,
  owner: string,
  requestId: string,
  action: string,
  payload: unknown,
  write: (tx: Executor) => Promise<T>,
): Promise<T> {
  ownerRequired(owner);
  const hash = createHash("sha256")
    .update(JSON.stringify([action, payload]))
    .digest("hex");
  return withSyncWrite(db, owner, async (tx) => {
    const claimed = await tx.query(
      "INSERT INTO library_operations(owner_id,request_id,fingerprint) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING request_id",
      [owner, requestId, hash],
    );
    if (!claimed.rows.length) {
      const old = (
        await tx.query(
          "SELECT fingerprint,result FROM library_operations WHERE owner_id=$1 AND request_id=$2",
          [owner, requestId],
        )
      ).rows[0];
      if (old?.fingerprint !== hash || !old.result)
        throw new LibraryError(
          409,
          "요청 내용이 변경되었습니다. 다시 확인해 주세요.",
        );
      return old.result as T;
    }
    const result = await write(tx);
    await tx.query(
      "UPDATE library_operations SET result=$3 WHERE owner_id=$1 AND request_id=$2",
      [owner, requestId, JSON.stringify(result)],
    );
    return result;
  });
}
export function createBookExclusionStore(db: Database) {
  return {
    async list(owner: string, raw: unknown): Promise<BookExclusionPage> {
      ownerRequired(owner);
      const p = z
        .object({
          q: z.string().trim().max(200).default(""),
          limit: z.coerce.number().int().min(1).max(50).default(30),
          offset: z.coerce.number().int().min(0).max(1000000).default(0),
        })
        .parse(raw);
      return db.transaction(async (tx) => {
        await tx.query(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
        );
        const from =
          "FROM library_book_exclusions e JOIN library_books b ON b.owner_id=e.owner_id AND b.id=e.id WHERE e.owner_id=$1 AND e.state='excluded' AND ($2='' OR strpos(lower(concat_ws(' ',b.title,b.author,b.isbn)),lower($2))>0)";
        const total = (
          await tx.query("SELECT count(*)::int AS total " + from, [owner, p.q])
        ).rows[0].total;
        const items = (
          await tx.query(
            `SELECT e.id,b.title,b.author,e.kind,e.reason,e.created_at AS "excludedAt",e.version,coalesce((SELECT min(d.relative_path) FROM library_documents d WHERE d.owner_id=e.owner_id AND d.book_id=e.id),'') AS "relativePath" ${from} ORDER BY b.title,e.id LIMIT $3 OFFSET $4`,
            [owner, p.q, p.limit, p.offset],
          )
        ).rows;
        return JSON.parse(JSON.stringify({ total, items }));
      });
    },
    async exclude(owner: string, raw: unknown) {
      const p = excludeInput.parse(raw),
        items = [...p.items].sort((a, b) => a.id.localeCompare(b.id));
      if (new Set(items.map((x) => x.id)).size !== items.length)
        throw new LibraryError(400, "중복된 자료가 있습니다.");
      return operation(
        db,
        owner,
        p.requestId,
        "excludeBooks",
        items,
        async (tx) => {
          const ids = items.map((x) => x.id);
          const books = (
            await tx.query(
              "SELECT id,version FROM library_books WHERE owner_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE",
              [owner, ids],
            )
          ).rows;
          const docs = (
            await tx.query(
              "SELECT id,book_id,material_kind,processing_scope FROM library_documents WHERE owner_id=$1 AND book_id=ANY($2::uuid[]) ORDER BY id FOR UPDATE",
              [owner, ids],
            )
          ).rows;
          const versions = new Map(books.map((x) => [x.id, x.version]));
          const documentsByBook = new Map<string, typeof docs>();
          for (const doc of docs) {
            const linked = documentsByBook.get(doc.book_id) ?? [];
            linked.push(doc);
            documentsByBook.set(doc.book_id, linked);
          }
          for (const item of items) {
            const linked = documentsByBook.get(item.id) ?? [];
            if (
              versions.get(item.id) !== item.expectedVersion ||
              !linked.length ||
              linked.some(
                (d) =>
                  d.material_kind !== item.kind ||
                  d.processing_scope !== "metadata_only",
              )
            )
              throw new LibraryError(
                409,
                "자료나 분류가 변경되었습니다. 제외 대상을 다시 확인해 주세요.",
              );
          }
          const previous = (
            await tx.query(
              "SELECT * FROM library_book_exclusions WHERE owner_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE",
              [owner, ids],
            )
          ).rows;
          const before = new Map(previous.map((x) => [x.id, x]));
          const after = (
            await tx.query(
              `INSERT INTO library_book_exclusions(id,owner_id,kind,reason,batch_id)
          SELECT x.id,$1,x.kind,'논문·간행물 일괄 제외',$3 FROM jsonb_to_recordset($2::jsonb) x(id uuid,kind text)
          ON CONFLICT(owner_id,id) DO UPDATE SET state='excluded',kind=excluded.kind,reason=excluded.reason,batch_id=excluded.batch_id,version=library_book_exclusions.version+1,updated_at=now() WHERE library_book_exclusions.state<>'excluded' RETURNING *`,
              [owner, JSON.stringify(items), p.requestId],
            )
          ).rows;
          if (after.length)
            await tx.query(
              `INSERT INTO library_revisions(id,owner_id,entity_id,action,before_data,after_data)
          SELECT x.id,$1,x.entity_id,'excludeBook',x.before_data,x.after_data FROM jsonb_to_recordset($2::jsonb) x(id uuid,entity_id uuid,before_data jsonb,after_data jsonb)`,
              [
                owner,
                JSON.stringify(
                  after.map((row) => ({
                    id: randomUUID(),
                    entity_id: row.id,
                    before_data: before.get(row.id) ?? null,
                    after_data: row,
                  })),
                ),
              ],
            );
          return {
            excluded: after.length,
            selected: items.length,
            batchId: p.requestId,
          };
        },
      );
    },
    async restore(owner: string, raw: unknown) {
      const p = restoreInput.parse(raw);
      return operation(
        db,
        owner,
        p.requestId,
        "restoreBook",
        { id: p.id, expectedVersion: p.expectedVersion },
        async (tx) => {
          const before = (
            await tx.query(
              "SELECT * FROM library_book_exclusions WHERE owner_id=$1 AND id=$2 FOR UPDATE",
              [owner, p.id],
            )
          ).rows[0];
          if (!before)
            throw new LibraryError(404, "제외한 자료를 찾을 수 없습니다.");
          if (
            before.state !== "excluded" ||
            before.version !== p.expectedVersion
          )
            throw new LibraryError(
              409,
              "자료 상태가 변경되었습니다. 목록을 새로고침해 주세요.",
            );
          const after = (
            await tx.query(
              "UPDATE library_book_exclusions SET state='restored',version=version+1,updated_at=now() WHERE owner_id=$1 AND id=$2 RETURNING *",
              [owner, p.id],
            )
          ).rows[0];
          await tx.query(
            "INSERT INTO library_revisions(id,owner_id,entity_id,action,before_data,after_data) VALUES($1,$2,$3,'restoreBook',$4,$5)",
            [
              randomUUID(),
              owner,
              p.id,
              JSON.stringify(before),
              JSON.stringify(after),
            ],
          );
          return { id: p.id, version: after.version, restored: true };
        },
      );
    },
  };
}
