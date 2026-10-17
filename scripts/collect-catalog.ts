/** Development only. No app startup, no generated reviews, no bulk HTML scraping. */
import { Pool } from "pg";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { runCatalogBatch } from "../src/local/curation/catalog-runner";
import type { Database } from "../src/server/library-store";
const args = process.argv.slice(2),
  apply = args.includes("--apply"),
  online = args.includes("--online"),
  provider = args.includes("--google") ? "google" : "library";
const limit = args.includes("--limit")
  ? Number(args[args.indexOf("--limit") + 1])
  : 30;
if (!Number.isInteger(limit) || limit < 1 || limit > 100)
  throw Error("한 번에 1~100권을 지정하세요.");
const key =
  provider === "google"
    ? process.env.GOOGLE_BOOKS_API_KEY
    : process.env.DATA4LIBRARY_KEY;
if (online && !key)
  throw Error("서지 API 인증키가 없습니다. 인증키 설정 후 다시 실행하세요.");
const dir = resolve(
  process.env.CATALOG_CACHE_DIR || "private-data/catalog",
  provider,
);
await mkdir(dir, { recursive: true });
const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL,
  max: 1,
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
  const owner = (
    await pool.query(
      'SELECT id::text FROM neon_auth."user" WHERE lower(email)=lower($1)',
      [process.env.LIBRARY_OWNER_EMAIL],
    )
  ).rows[0]?.id;
  if (!owner) throw Error("소유자 확인 실패");
  const books = (
    await pool.query(
      "SELECT b.id,b.isbn,b.version FROM library_active_books b WHERE b.owner_id=$1 AND b.isbn<>'' AND (coalesce(b.source_data->>'app','')<>'Local PDF' OR EXISTS(SELECT 1 FROM library_documents d WHERE d.owner_id=b.owner_id AND d.book_id=b.id AND d.processing_scope='full')) AND NOT EXISTS(SELECT 1 FROM library_curation_items c WHERE c.owner_id=b.owner_id AND c.source_kind='book' AND c.source_id=b.id::text AND c.source_version=b.version::text AND c.kind='bibliography' AND c.generator=$2) ORDER BY b.id",
      [
        owner,
        (provider === "google" ? "Google Books" : "도서관 정보나루") + "/v1",
      ],
    )
  ).rows;
  const stats = await runCatalogBatch({
    db,
    owner,
    books,
    provider,
    key: key ?? "",
    dir,
    online,
    apply,
    limit,
  });
  console.log(JSON.stringify(stats));
} finally {
  await pool.end();
}
