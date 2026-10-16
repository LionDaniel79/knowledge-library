import { randomUUID } from "node:crypto";
import { z } from "zod";
import { introductionSchema } from "../lib/book-introduction";
import { LibraryError, type Database, type Executor } from "./library-store";
import { readCurationSource } from "./curation-store";
export async function readBookIntroduction(
  db: Executor,
  owner: string,
  id: string,
) {
  z.string().uuid().parse(id);
  const b = (
    await db.query(
      "SELECT id,version FROM library_books WHERE owner_id=$1 AND id=$2",
      [owner, id],
    )
  ).rows[0];
  if (!b) throw new LibraryError(404, "책을 찾을 수 없습니다.");
  await readCurationSource(db, owner, {
    kind: "book",
    id,
    version: String(b.version),
  });
  const introduction =
    (
      await db.query(
        'SELECT text,sources,version,book_version AS "bookVersion",updated_at AS "updatedAt" FROM library_book_introductions WHERE owner_id=$1 AND book_id=$2',
        [owner, id],
      )
    ).rows[0] ?? null;
  const references = (
    await db.query(
      `SELECT c.id,c.value,r.url,r.provider FROM library_curation_items c JOIN library_reference_sources r ON r.owner_id=c.owner_id AND r.id::text=c.evidence->>'referenceId' WHERE c.owner_id=$1 AND c.source_kind='book' AND c.source_id=$2 AND c.source_version=$3 AND c.kind='publisher_intro' AND c.state='active' ORDER BY c.created_at DESC LIMIT 10`,
      [owner, id, String(b.version)],
    )
  ).rows;
  return { introduction, references, bookVersion: b.version };
}
export async function saveBookIntroduction(
  db: Database,
  owner: string,
  raw: unknown,
) {
  if (!owner) throw new LibraryError(401, "로그인이 필요합니다.");
  const p = introductionSchema.parse(raw);
  return db.transaction(async (tx) => {
    await readCurationSource(
      tx,
      owner,
      { kind: "book", id: p.bookId, version: String(p.bookVersion) },
      true,
    );
    const b = (
      await tx.query(
        "SELECT version FROM library_books WHERE owner_id=$1 AND id=$2 FOR UPDATE",
        [owner, p.bookId],
      )
    ).rows[0];
    if (!b || b.version !== p.bookVersion)
      throw new LibraryError(
        409,
        "책 정보가 변경되었습니다. 다시 열어 주세요.",
      );
    const old = (
      await tx.query(
        "SELECT * FROM library_book_introductions WHERE owner_id=$1 AND book_id=$2 FOR UPDATE",
        [owner, p.bookId],
      )
    ).rows[0];
    if (old?.request_id === p.requestId) return { version: old.version };
    if ((old?.version ?? 0) !== p.expectedVersion)
      throw new LibraryError(
        409,
        "다른 곳에서 소개를 수정했습니다. 다시 열어 주세요.",
      );
    const version = p.expectedVersion + 1,
      after = {
        text: p.text,
        sources: p.sources,
        version,
        bookVersion: p.bookVersion,
      };
    await tx.query(
      `INSERT INTO library_book_introductions(id,owner_id,book_id,book_version,text,sources,version,request_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(owner_id,book_id) DO UPDATE SET book_version=excluded.book_version,text=excluded.text,sources=excluded.sources,version=excluded.version,request_id=excluded.request_id,updated_at=now()`,
      [
        old?.id ?? randomUUID(),
        owner,
        p.bookId,
        p.bookVersion,
        p.text,
        JSON.stringify(p.sources),
        version,
        p.requestId,
      ],
    );
    await tx.query(
      "INSERT INTO library_revisions(id,owner_id,entity_id,action,before_data,after_data) VALUES($1,$2,$3,'editIntroduction',$4,$5)",
      [
        randomUUID(),
        owner,
        p.bookId,
        JSON.stringify(old ?? null),
        JSON.stringify(after),
      ],
    );
    return { version };
  });
}
