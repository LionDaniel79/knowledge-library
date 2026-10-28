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
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 }),
  db = createPoolDatabase(pool);
try {
  const rows = (
    await db.query(
      "SELECT r.id,r.record->>'isbn' candidate_isbn,b.id book_id,b.isbn,b.version,b.source_data->>'app' app FROM library_catalog_reviews r JOIN library_active_books b ON b.owner_id=r.owner_id AND b.id=r.book_id WHERE r.owner_id=$1 AND r.status='pending'",
      [owner],
    )
  ).rows;
  const wrong = rows.filter(
    (r) => isbn13(r.isbn) && isbn13(r.isbn) !== isbn13(r.candidate_isbn),
  );
  const waiting = rows.filter((r) => !isbn13(r.isbn) && r.app === "Local PDF");
  let superseded = 0,
    deferred = 0;
  if (process.argv.includes("--apply"))
    for (const [kind, items] of [
      ["different_owned_isbn", wrong],
      ["pdf_isbn_evidence_pending", waiting],
    ] as const)
      for (let offset = 0; offset < items.length; offset += 200)
        await withSyncWrite(db, owner, async (tx) => {
          const part = items.slice(offset, offset + 200),
            status =
              kind === "different_owned_isbn" ? "superseded" : "deferred";
          const inputs = part.map((r) => ({
            id: r.id,
            book_id: r.book_id,
            version: r.version,
          }));
          const changed = await tx.query(
            "UPDATE library_catalog_reviews r SET status=$3,decision=coalesce(decision,'{}')||jsonb_build_object('reviewedBy','isbn_reconciliation','reason',$4::text,'previousState',r.status),version=r.version+1,updated_at=now() FROM library_books b,jsonb_to_recordset($2::jsonb) x(id uuid,book_id uuid,version integer) WHERE r.owner_id=$1 AND r.id=x.id AND r.book_id=x.book_id AND r.status='pending' AND b.owner_id=r.owner_id AND b.id=r.book_id AND b.version=x.version RETURNING r.id",
            [owner, JSON.stringify(inputs), status, kind],
          );
          if (status === "deferred") {
            const queued = [
              ...new Map(part.map((r) => [r.book_id, r])).values(),
            ].map((r) => ({
              id: r.book_id,
              version: r.version,
              work: {
                state: "needs_isbn",
                owner,
                scope: catalogCollectorScope(process.env.LIBRARY_OWNER_EMAIL!),
                token: randomUUID(),
                isbn: "",
                attempts: 0,
                nextAttemptAt: 0,
              },
            }));
            await tx.query(
              "UPDATE library_books b SET enrichment=enrichment||jsonb_build_object('catalogSupplement',x.work) FROM jsonb_to_recordset($2::jsonb) x(id uuid,version integer,work jsonb) WHERE b.owner_id=$1 AND b.id=x.id AND b.version=x.version AND b.enrichment->'catalogSupplement' IS NULL",
              [owner, JSON.stringify(queued)],
            );
          }
          if (status === "deferred") deferred += changed.rows.length;
          else superseded += changed.rows.length;
        });
  const counts = (
    await db.query(
      "SELECT status,count(*)::int candidates,count(DISTINCT book_id)::int books FROM library_catalog_reviews WHERE owner_id=$1 GROUP BY status ORDER BY status",
      [owner],
    )
  ).rows;
  console.log(
    JSON.stringify({
      wrongEditionCandidates: wrong.length,
      awaitingPdfIsbn: waiting.length,
      superseded,
      deferred,
      counts,
    }),
  );
} finally {
  await pool.end();
}
