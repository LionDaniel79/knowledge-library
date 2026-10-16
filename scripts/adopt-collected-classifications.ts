/** Development batch: use stored official metadata only, with no external requests. */
import { Pool } from "pg";
import { writeFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { Database } from "../src/server/library-store";
import { verifiedCurationOwner } from "../src/local/curation/owner";
import { adoptCollectedClassification } from "../src/local/curation/verified-classification";
import {
  classificationBooks,
  parseClassificationIds,
} from "../src/local/curation/classification-selection";
const args = process.argv.slice(2),
  arg = (name: string) =>
    args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const output = arg("--output"),
  limit = Number(arg("--limit") ?? 20),
  apply = args.includes("--apply");
if (args.includes("--book-ids") && !arg("--book-ids"))
  throw Error("--book-ids에는 새로 확인한 도서 ID를 지정하세요.");
const bookIds = parseClassificationIds(arg("--book-ids"));
if (!output || !Number.isInteger(limit) || limit < 1 || limit > 5000)
  throw Error("--output 파일과 1~5000건 --limit을 지정하세요.");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL_UNPOOLED,
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
const stats = {
    startedAt: new Date().toISOString(),
    apply,
    total: 0,
    processed: 0,
    ready: 0,
    applied: 0,
    skipped: 0,
    stopped: "running",
  },
  rows: unknown[] = [];
async function save() {
  const temp = output + "." + randomUUID() + ".tmp";
  await writeFile(
    temp,
    JSON.stringify(
      { ...stats, updatedAt: new Date().toISOString(), rows },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  await rename(temp, output!);
}
try {
  const owner = await verifiedCurationOwner(
    db,
    process.env.LIBRARY_OWNER_EMAIL,
  );
  const books = await classificationBooks(db, owner, bookIds);
  stats.total = books.length;
  await save();
  for (const b of books.slice(0, limit)) {
    const result = await adoptCollectedClassification(
      db,
      owner,
      b.id,
      b.version,
      apply,
    );
    stats.processed++;
    if (result.ready) stats.ready++;
    else stats.skipped++;
    if (result.applied) stats.applied++;
    rows.push({ bookId: b.id, title: b.title, ...result });
    if (stats.processed % 25 === 0) {
      await save();
      console.log(JSON.stringify(stats));
    }
  }
  stats.stopped = stats.processed === stats.total ? "complete" : "batch_limit";
} catch {
  stats.stopped = "error";
  process.exitCode = 1;
  console.error(
    "공식 분류 반영 중단: 자료와 변경 이력은 보존됩니다. 보고서에서 마지막 상태를 확인하세요.",
  );
} finally {
  await save();
  await pool.end();
  console.log(JSON.stringify(stats));
}
