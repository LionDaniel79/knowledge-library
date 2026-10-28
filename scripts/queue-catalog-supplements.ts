import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { isbn13 } from "../src/lib/bibliography";
import { verifiedCurationOwner } from "../src/local/curation/owner";
import { catalogCollectorScope } from "../src/server/catalog-supplement-queue";
import { createPoolDatabase } from "../src/server/sync/pool-database";
import { withSyncWrite } from "../src/server/sync/write";
const auth = new Pool({
  connectionString: process.env.DATABASE_URL_UNPOOLED,
  max: 1,
});
let owner: string;
try {
  owner = await verifiedCurationOwner(
    { query: (s, p) => auth.query(s, p) },
    process.env.LIBRARY_OWNER_EMAIL,
  );
} finally {
  await auth.end();
}
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
  }),
  db = createPoolDatabase(pool);
try {
  const books = (
    await db.query(
      `SELECT id,isbn,version FROM library_active_books b WHERE owner_id=$1 AND isbn<>'' AND enrichment->'catalogSupplement' IS NULL AND NOT EXISTS(SELECT 1 FROM library_documents d WHERE d.owner_id=b.owner_id AND d.book_id=b.id AND(d.processing_scope<>'full' OR d.material_kind~*'paper|periodical|journal|thesis')) AND(coalesce(b.source_data->>'app','')<>'Local PDF' OR EXISTS(SELECT 1 FROM library_documents d WHERE d.owner_id=b.owner_id AND d.book_id=b.id)) AND((cover_url='' AND source_data->'cover' IS NULL) OR (classification->>'verified' IS DISTINCT FROM 'true' AND classification->>'method' IS DISTINCT FROM 'manual') OR NOT EXISTS(SELECT 1 FROM library_curation_items c WHERE c.owner_id=b.owner_id AND c.source_kind='book' AND c.source_id=b.id::text AND c.source_version=b.version::text AND c.kind='toc')) ORDER BY b.created_at LIMIT 2000`,
      [owner],
    )
  ).rows.filter((b) => isbn13(b.isbn));
  let queued = 0;
  if (process.argv.includes("--apply"))
    for (let offset = 0; offset < books.length; offset += 100)
      await withSyncWrite(db, owner, async (tx) => {
        const inputs = books.slice(offset, offset + 100).map((b) => ({
          id: b.id,
          version: b.version,
          work: {
            state: "pending",
            owner,
            isbn: isbn13(b.isbn),
            scope: catalogCollectorScope(process.env.LIBRARY_OWNER_EMAIL!),
            token: randomUUID(),
            attempts: 0,
            nextAttemptAt: 0,
          },
        }));
        const r = await tx.query(
          "UPDATE library_books b SET enrichment=enrichment||jsonb_build_object('catalogSupplement',x.work) FROM jsonb_to_recordset($2::jsonb) x(id uuid,version integer,work jsonb) WHERE b.owner_id=$1 AND b.id=x.id AND b.version=x.version AND b.enrichment->'catalogSupplement' IS NULL RETURNING b.id",
          [owner, JSON.stringify(inputs)],
        );
        queued += r.rows.length;
      });
  console.log(JSON.stringify({ eligible: books.length, queued }));
} finally {
  await pool.end();
}
