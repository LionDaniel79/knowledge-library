import { Pool } from "pg";
import { writeFile } from "node:fs/promises";
import { createPoolDatabase } from "../src/server/sync/pool-database";
import { verifiedCurationOwner } from "../src/local/curation/owner";
import { reconcileCatalogReviews } from "../src/local/curation/catalog-reconcile";
const auth = new Pool({
  connectionString: process.env.DATABASE_URL_UNPOOLED,
  max: 1,
  connectionTimeoutMillis: 15000,
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
  connectionTimeoutMillis: 15000,
});
const db = createPoolDatabase(pool),
  args = process.argv.slice(2),
  apply = args.includes("--apply");
const transaction = db.transaction;
db.transaction = (fn) =>
  transaction(async (tx) => {
    await tx.query("SET LOCAL statement_timeout='15s'");
    return fn(tx);
  });
const fingerprint = async () =>
  (
    await db.query(
      "SELECT 'notes' kind,count(*)::int n,md5(string_agg(md5(to_jsonb(n)::text),'' ORDER BY id)) fingerprint FROM library_notes n WHERE owner_id=$1 UNION ALL SELECT 'cycles',count(*)::int,md5(string_agg(md5(to_jsonb(c)::text),'' ORDER BY id)) FROM library_cycles c WHERE owner_id=$1",
      [owner],
    )
  ).rows;
try {
  const before = await fingerprint();
  const report = await reconcileCatalogReviews(
    db,
    owner,
    apply,
    undefined,
    args.includes("--stop-on-error") ? 1 : Infinity,
  );
  const after = await fingerprint();
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw Error("Personal reading records changed.");
  const remaining = (
    await db.query(
      "SELECT count(*)::int candidates,count(DISTINCT book_id)::int books FROM library_catalog_reviews WHERE owner_id=$1 AND status='pending'",
      [owner],
    )
  ).rows[0];
  const result = {
    ...report,
    apply,
    remaining,
    personalRecordsUnchanged: true,
  };
  if (args.includes("--report"))
    await writeFile(
      args[args.indexOf("--report") + 1],
      JSON.stringify(result, null, 2),
    );
  console.log(JSON.stringify(result));
} finally {
  await pool.end();
}
