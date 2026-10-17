import { createPoolDatabase } from "../src/server/sync/pool-database";
import { syncQuery } from "../src/server/sync/write";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { lookupLibrary } from "../src/server/catalog-provider";
import { sameTitle } from "../src/lib/bibliography";
const key = process.env.DATA4LIBRARY_KEY;
if (!key)
  throw Error(
    "DATA4LIBRARY_KEY 설정이 필요합니다. docs/catalog-enrichment.md를 참고하세요.",
  );
const pool = new Pool({
  connectionString: process.env.DATABASE_URL_UNPOOLED,
  max: 1,
});
let matched = 0,
  review = 0;
try {
  const owner = (
    await pool.query(
      'SELECT id::text FROM neon_auth."user" WHERE lower(email)=lower($1) AND "emailVerified"=true',
      [process.env.LIBRARY_OWNER_EMAIL],
    )
  ).rows[0]?.id;
  if (!owner) throw Error("Verified owner required");
  const books = (
    await pool.query(
      "SELECT * FROM library_books WHERE owner_id=$1 AND isbn<>'' AND classification->>'method' IS DISTINCT FROM 'manual' AND classification->>'method' IS DISTINCT FROM 'ISBN 일치'",
      [owner],
    )
  ).rows;
  for (const book of books) {
    const result = await lookupLibrary(book.isbn, key);
    if (result && sameTitle(book.title, result.title) && result.category) {
      const r = await syncQuery(
        createPoolDatabase(pool),
        owner,
        `WITH updated AS (UPDATE library_books SET category=$3,classification=$4,cover_url=CASE WHEN cover_url='' AND source_data->'cover' IS NULL THEN $5 ELSE cover_url END,author=CASE WHEN author='' THEN $6 ELSE author END,publisher=CASE WHEN publisher='' THEN $7 ELSE publisher END,version=version+1 WHERE owner_id=$1 AND id=$2 AND version=$8 RETURNING *) INSERT INTO library_revisions(id,owner_id,entity_id,action,before_data,after_data) SELECT $9,$1,id,'verifyLibraryClassification',$10::jsonb,to_jsonb(updated) FROM updated RETURNING entity_id`,
        [
          owner,
          book.id,
          result.category,
          JSON.stringify(result.classification),
          result.coverUrl,
          result.author.slice(0, 300),
          result.publisher.slice(0, 300),
          book.version,
          randomUUID(),
          JSON.stringify(book),
        ],
      );
      matched += r.rowCount ?? 0;
    } else if (result) review++;
    if ((matched + review) % 50 === 0)
      console.log(JSON.stringify({ matched, review }));
    await new Promise((r) => setTimeout(r, 1100));
  }
  console.log(JSON.stringify({ matched, review, complete: true }));
} finally {
  await pool.end();
}
