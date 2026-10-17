import { createPoolDatabase } from "../src/server/sync/pool-database";
import { syncQuery } from "../src/server/sync/write";
import { Pool } from "pg";
import { createLegacyReadingStore } from "../src/server/legacy-reading-store";
import type { Database } from "../src/server/library-store";
const pool = new Pool({
  connectionString: process.env.DATABASE_URL_UNPOOLED,
  max: 1,
});
try {
  const owners = (
    await pool.query(
      'SELECT id FROM neon_auth."user" WHERE lower(email)=lower($1) AND "emailVerified"=true',
      [process.env.LIBRARY_OWNER_EMAIL],
    )
  ).rows;
  if (owners.length !== 1) throw Error("Verified owner required");
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
  const result = await createLegacyReadingStore(db).run(
    owners[0].id,
    process.argv.includes("--apply"),
  );
  // This metric is a user-confirmed source-app figure, not a rewritten cycle count.
  if (process.argv.includes("--apply"))
    await syncQuery(
      createPoolDatabase(pool),
      owners[0].id,
      `INSERT INTO library_annual_metrics(owner_id,year,reported_books,source,explanation) VALUES($1,2026,25.5,'iReadItNow HD','사용자가 원본 앱의 2026년 통계로 확인한 독서량. 완독 날짜 기준 횟수와 계산 기준이 다릅니다.') ON CONFLICT DO NOTHING`,
      [owners[0].id],
    );
  console.log(JSON.stringify(result));
} finally {
  await pool.end();
}
