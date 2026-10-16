import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  collectedReviewSchema,
  reviewDecisionSchema,
} from "../lib/catalog-review";
import { isbn13 } from "../lib/bibliography";
import {
  LibraryError,
  createLibraryStore,
  type Database,
  type Executor,
} from "./library-store";
import { bookSelect } from "./book-records";
import { collectBookReference } from "../local/curation/catalog";
async function documents(tx: Executor, owner: string, id: string) {
  return (
    await tx.query(
      "SELECT id,bytes::text,mtime_ns,processing_scope,material_kind FROM library_documents WHERE owner_id=$1 AND book_id=$2 ORDER BY id",
      [owner, id],
    )
  ).rows;
}
function documentSignature(rows: any[]) {
  return JSON.stringify(
    rows.map((d) => [
      d.id,
      String(d.bytes),
      d.mtime_ns,
      d.processing_scope,
      d.material_kind,
    ]),
  );
}
function eligible(book: any, docs: any[]) {
  return (
    !docs.some(
      (d) =>
        d.processing_scope !== "full" ||
        /paper|periodical|journal|thesis/i.test(d.material_kind),
    ) &&
    (book.sourceData?.app !== "Local PDF" || docs.length > 0)
  );
}
function snapshot(book: any) {
  const { id, title, author, publisher, isbn, coverUrl, version } = book;
  return { id, title, author, publisher, isbn, coverUrl, version };
}
/** Operator import: one statement per bounded batch; decisions remain immutable. */
export async function importCatalogReviewBatch(
  db: Executor,
  owner: string,
  inputs: { bookId: string; sourceVersion: number; record: unknown }[],
) {
  if (!owner) throw new LibraryError(401, "로그인이 필요합니다.");
  if (inputs.length > 100)
    throw new LibraryError(400, "한 번에 100개까지 가져올 수 있습니다.");
  const values = inputs.map((i) => {
    z.string().uuid().parse(i.bookId);
    z.number().int().positive().parse(i.sourceVersion);
    const record = collectedReviewSchema.parse(i.record);
    return {
      id: randomUUID(),
      book_id: i.bookId,
      source_version: i.sourceVersion,
      record,
      fingerprint: createHash("sha256")
        .update(JSON.stringify(record))
        .digest("hex"),
    };
  });
  const r = await db.query(
    `INSERT INTO library_catalog_reviews(id,owner_id,book_id,source_version,record,fingerprint,book_snapshot,document_versions)
 SELECT x.id,$1,b.id,b.version,x.record,x.fingerprint,
 jsonb_build_object('id',b.id,'title',b.title,'author',b.author,'publisher',b.publisher,'isbn',b.isbn,'coverUrl',b.cover_url,'version',b.version),
 coalesce((SELECT jsonb_agg(to_jsonb(dv) ORDER BY dv.id) FROM(SELECT d.id,d.bytes::text,d.mtime_ns,d.processing_scope,d.material_kind FROM library_documents d WHERE d.owner_id=$1 AND d.book_id=b.id)dv),'[]'::jsonb)
 FROM jsonb_to_recordset($2::jsonb) AS x(id uuid,book_id uuid,source_version integer,record jsonb,fingerprint text)
 JOIN library_books b ON b.owner_id=$1 AND b.id=x.book_id AND b.version=x.source_version
 WHERE NOT EXISTS(SELECT 1 FROM library_documents d WHERE d.owner_id=$1 AND d.book_id=b.id AND (d.processing_scope<>'full' OR d.material_kind~*'paper|periodical|journal|thesis'))
 AND(coalesce(b.source_data->>'app','')<>'Local PDF' OR EXISTS(SELECT 1 FROM library_documents d WHERE d.owner_id=$1 AND d.book_id=b.id AND d.processing_scope='full'))
 ON CONFLICT(owner_id,book_id,source_version,fingerprint) DO NOTHING RETURNING id`,
    [owner, JSON.stringify(values)],
  );
  return r.rows.length;
}
export async function importCatalogReview(
  db: Database,
  owner: string,
  input: { bookId: string; sourceVersion: number; record: unknown },
) {
  if (!owner) throw new LibraryError(401, "로그인이 필요합니다.");
  z.string().uuid().parse(input.bookId);
  const record = collectedReviewSchema.parse(input.record);
  return db.transaction(async (tx) => {
    const b = (
      await tx.query(
        `SELECT ${bookSelect} FROM library_books WHERE owner_id=$1 AND id=$2 FOR UPDATE`,
        [owner, input.bookId],
      )
    ).rows[0];
    if (!b || b.version !== input.sourceVersion) return null;
    const docs = await documents(tx, owner, b.id);
    if (!eligible(b, docs)) return null;
    const hash = createHash("sha256")
      .update(JSON.stringify(record))
      .digest("hex");
    const r = await tx.query(
      `INSERT INTO library_catalog_reviews(id,owner_id,book_id,source_version,book_snapshot,document_versions,record,fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(owner_id,book_id,source_version,fingerprint) DO NOTHING RETURNING id`,
      [
        randomUUID(),
        owner,
        b.id,
        b.version,
        JSON.stringify(snapshot(b)),
        JSON.stringify(docs),
        JSON.stringify(record),
        hash,
      ],
    );
    return r.rows[0]?.id ?? null;
  });
}
export async function readCatalogReviews(
  db: Executor,
  owner: string,
  query: Record<string, unknown>,
) {
  if (!owner) throw new LibraryError(401, "로그인이 필요합니다.");
  const q = z
    .object({
      status: z
        .enum(["pending", "deferred", "rejected", "applied", "superseded"])
        .default("pending"),
      q: z.string().max(200).default(""),
      offset: z.coerce.number().int().min(0).max(1000000).default(0),
      id: z.string().uuid().optional(),
    })
    .parse(query);
  if (q.id) {
    const row = (
      await db.query(
        `SELECT r.*,b.version AS current_version FROM library_catalog_reviews r JOIN library_books b ON b.owner_id=r.owner_id AND b.id=r.book_id WHERE r.owner_id=$1 AND r.id=$2`,
        [owner, q.id],
      )
    ).rows[0];
    if (!row) throw new LibraryError(404, "후보를 찾을 수 없습니다.");
    const b = (
      await db.query(
        `SELECT ${bookSelect} FROM library_books WHERE owner_id=$1 AND id=$2`,
        [owner, row.book_id],
      )
    ).rows[0];
    return { ...row, current: snapshot(b) };
  }
  const params = [owner, q.status, q.q];
  const where =
    "owner_id=$1 AND status=$2 AND ($3='' OR strpos(lower(book_snapshot->>'title'),lower($3))>0 OR strpos(lower(record->>'title'),lower($3))>0)";
  const count = (
    await db.query(
      `SELECT count(*)::int AS n FROM library_catalog_reviews WHERE ${where}`,
      params,
    )
  ).rows[0].n;
  const items = (
    await db.query(
      `SELECT id,book_id,book_snapshot->>'title' AS title,record->>'title' AS candidate_title,record->>'isbn' AS isbn,status,version FROM library_catalog_reviews WHERE ${where} ORDER BY created_at,id LIMIT 20 OFFSET $4`,
      [...params, q.offset],
    )
  ).rows;
  return {
    items,
    total: count,
    nextOffset:
      q.offset + items.length < count ? q.offset + items.length : null,
  };
}
export async function decideCatalogReview(
  db: Database,
  owner: string,
  raw: unknown,
) {
  if (!owner) throw new LibraryError(401, "로그인이 필요합니다.");
  const input = reviewDecisionSchema.parse(raw);
  return db.transaction(async (tx) => {
    const row = (
      await tx.query(
        "SELECT * FROM library_catalog_reviews WHERE owner_id=$1 AND id=$2 FOR UPDATE",
        [owner, input.id],
      )
    ).rows[0];
    if (!row) throw new LibraryError(404, "후보를 찾을 수 없습니다.");
    if (row.decision_request_id === input.requestId) return row.decision;
    if (
      row.version !== input.expectedVersion ||
      !["pending", "deferred"].includes(row.status)
    )
      throw new LibraryError(
        409,
        "후보 상태가 바뀌었습니다. 다시 열어 주세요.",
      );
    const result: any = { action: input.action, fields: input.fields };
    if (input.action === "apply") {
      if (!input.sameEdition || !input.fields.length)
        throw new LibraryError(
          400,
          "같은 판본인지 확인하고 반영할 항목을 선택하세요.",
        );
      const b = (
        await tx.query(
          `SELECT ${bookSelect} FROM library_books WHERE owner_id=$1 AND id=$2 FOR UPDATE`,
          [owner, row.book_id],
        )
      ).rows[0];
      const docs = await documents(tx, owner, row.book_id);
      if (
        !b ||
        b.version !== row.source_version ||
        !eligible(b, docs) ||
        documentSignature(docs) !== documentSignature(row.document_versions)
      )
        throw new LibraryError(
          409,
          "책이나 PDF가 변경되었습니다. 새 후보를 확인해 주세요.",
        );
      const record = collectedReviewSchema.parse(row.record),
        selected = Object.fromEntries(
          input.fields.map((k) => [k, record.facts[k]]),
        ),
        merged = { ...b, ...selected };
      if (!isbn13(merged.isbn) || isbn13(merged.isbn) !== isbn13(record.isbn))
        throw new LibraryError(
          400,
          "후보와 같은 ISBN으로 확인해야 목차·표지를 연결할 수 있습니다.",
        );
      const nested: Database = { query: tx.query, transaction: (fn) => fn(tx) };
      await createLibraryStore(nested).mutate(owner, {
        type: "editBook",
        requestId: input.requestId,
        payload: {
          ...merged,
          id: b.id,
          expectedVersion: b.version,
          catalogSelection: {
            provider: "yes24",
            sourceUrl: record.url,
            description: (record.description ?? "").slice(0, 3000),
          },
        },
      });
      await collectBookReference(
        nested,
        owner,
        { kind: "book", id: b.id, version: String(b.version + 1) },
        {
          ...record,
          facts: {
            ...record.facts,
            coverUrl: input.fields.includes("coverUrl")
              ? record.facts.coverUrl
              : "",
          },
        },
        true,
      );
      await tx.query(
        "UPDATE library_curation_items SET reviewed_by='human' WHERE owner_id=$1 AND source_kind='book' AND source_id=$2 AND source_version=$3",
        [owner, b.id, String(b.version + 1)],
      );
      await tx.query(
        "UPDATE library_catalog_reviews SET status='superseded',version=version+1,updated_at=now() WHERE owner_id=$1 AND book_id=$2 AND id<>$3 AND status IN ('pending','deferred')",
        [owner, b.id, row.id],
      );
      result.bookId = b.id;
    }
    await tx.query(
      "UPDATE library_catalog_reviews SET status=$3,version=version+1,decision_request_id=$4,decision=$5,updated_at=now() WHERE owner_id=$1 AND id=$2",
      [
        owner,
        row.id,
        input.action === "apply"
          ? "applied"
          : input.action === "defer"
            ? "deferred"
            : "rejected",
        input.requestId,
        JSON.stringify(result),
      ],
    );
    return result;
  });
}
