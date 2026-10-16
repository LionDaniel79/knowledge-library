import { collectedReviewSchema } from "../src/lib/catalog-review";
/** Finite, repeatable import of the existing YES24 checkpoint. No provider calls. */
import { Pool } from "pg";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { verifiedCurationOwner } from "../src/local/curation/owner";
import { importCatalogReviewBatch } from "../src/server/catalog-review-store";
import type { Database } from "../src/server/library-store";
const dir = process.argv[process.argv.indexOf("--dir") + 1];
if (!process.argv.includes("--dir") || !dir) throw Error("--dir 저장폴더 필요");
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
      const result = await fn({ query: (s, p = []) => c.query(s, p) });
      await c.query("COMMIT");
      return result;
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
    ),
    job = JSON.parse(await readFile(join(resolve(dir), "job.json"), "utf8"));
  if (createHash("sha256").update(owner).digest("hex") !== job.ownerHash)
    throw Error("작업 소유자 불일치");
  let batch: any[] = [];
  async function flush() {
    if (batch.length) {
      imported += await importCatalogReviewBatch(db, owner, batch);
      batch = [];
    }
  }
  let imported = 0,
    invalid = 0;
  for (const file of await readdir(join(dir, "results"))) {
    if (!file.endsWith(".json")) continue;
    const r = JSON.parse(await readFile(join(dir, "results", file), "utf8"));
    if (r.status !== "review_required") continue;
    for (const record of r.records ?? []) {
      try {
        const parsed = collectedReviewSchema.parse(record);
        batch.push({
          bookId: r.bookId,
          sourceVersion: r.sourceVersion,
          record: parsed,
        });
        if (batch.length >= 50) await flush();
      } catch (e) {
        if ((e as Error).name === "ZodError") invalid++;
        else throw e;
      }
    }
  }
  await flush();
  console.log(JSON.stringify({ imported, invalid }));
} finally {
  await pool.end();
}
