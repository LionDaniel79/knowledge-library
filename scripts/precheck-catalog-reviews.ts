import { Pool } from "pg";
import { writeFile } from "node:fs/promises";
import { verifiedCurationOwner } from "../src/local/curation/owner";
import { precheckCatalogReviews } from "../src/local/curation/catalog-precheck";
import type { Database } from "../src/server/library-store";
const args = process.argv.slice(2),
  path = args.includes("--report")
    ? args[args.indexOf("--report") + 1]
    : undefined;
const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL,
  max: 1,
  connectionTimeoutMillis: 15000,
});
const db: Database = {
  query: (s, p = []) => pool.query(s, p),
  transaction: async (fn) => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const r = await fn({ query: (s, p = []) => c.query(s, p) });
      await c.query("COMMIT");
      return r;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  },
};
try {
  const owner = await verifiedCurationOwner(
    db,
    process.env.LIBRARY_OWNER_EMAIL,
  );
  const fingerprints = async () =>
    (
      await db.query(
        "SELECT 'notes' AS kind,count(*)::int AS n,md5(string_agg(md5(to_jsonb(n)::text),'' ORDER BY id)) AS fingerprint FROM library_notes n WHERE owner_id=$1 UNION ALL SELECT 'cycles',count(*)::int,md5(string_agg(md5(to_jsonb(c)::text),'' ORDER BY id)) FROM library_cycles c WHERE owner_id=$1",
        [owner],
      )
    ).rows;
  const before = await fingerprints(),
    result = await precheckCatalogReviews(db, owner, args.includes("--apply")),
    after = await fingerprints();
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw Error("Personal records changed; inspect before continuing.");
  const remaining = (
    await db.query(
      "SELECT count(*)::int AS candidates,count(DISTINCT book_id)::int AS books FROM library_catalog_reviews WHERE owner_id=$1 AND status='pending'",
      [owner],
    )
  ).rows[0];
  const report = {
    checkedAt: new Date().toISOString(),
    ...result,
    remaining,
    personalRecordsUnchanged: true,
  };
  if (path) await writeFile(path, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await pool.end();
}
