import { Pool } from "pg";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { acquireYes24Lock } from "../src/local/curation/yes24-batch";
import { createPoolDatabase } from "../src/server/sync/pool-database";
import {
  catalogCollectorScope,
  claimCatalogSupplement,
  enqueueCatalogSupplement,
} from "../src/server/catalog-supplement-queue";
import { withSyncWrite } from "../src/server/sync/write";
import { isbn13 } from "../src/lib/bibliography";
import { bookSelect } from "../src/server/book-records";
import {
  collectSupplementRecords,
  supplementBook,
} from "../src/local/curation/catalog-supplement";
import { supplementLookup } from "../src/local/curation/supplement-providers";
import { atomicWriteJson } from "../src/local/atomic-json";
import { reconcileCatalogReviews } from "../src/local/curation/catalog-reconcile";
if (!process.env.LIBRARY_OWNER_EMAIL || !process.env.CATALOG_CACHE_DIR)
  throw Error("PC catalog configuration required.");
const dir = join(process.env.CATALOG_CACHE_DIR, "supplement");
await mkdir(dir, { recursive: true });
const release = acquireYes24Lock(join(dir, "worker-lock.sqlite"));
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  connectionTimeoutMillis: 15000,
  idleTimeoutMillis: 10000,
});
pool.on("error", () => {});
const db = createPoolDatabase(pool),
  lookup = supplementLookup(dir),
  scope = catalogCollectorScope(process.env.LIBRARY_OWNER_EMAIL);
let running = true;
let idleMs = 60000;
process.on("SIGTERM", () => {
  running = false;
});
process.on("SIGINT", () => {
  running = false;
});
try {
  do {
    const stats = {
      at: new Date().toISOString(),
      checked: 0,
      completed: 0,
      pending: 0,
      failed: 0,
    };
    try {
      const identified = (
        await db.query(
          "SELECT id,isbn,owner_id FROM library_active_books WHERE enrichment->'catalogSupplement'->>'scope'=$1 AND enrichment->'catalogSupplement'->>'state'='needs_isbn' AND isbn<>'' LIMIT 10",
          [scope],
        )
      ).rows;
      for (const b of identified)
        if (isbn13(b.isbn))
          await withSyncWrite(db, b.owner_id, async (tx) => {
            const current = (
              await tx.query(
                `SELECT ${bookSelect} FROM library_books WHERE owner_id=$1 AND id=$2 FOR UPDATE`,
                [b.owner_id, b.id],
              )
            ).rows[0];
            if (
              current?.enrichment?.catalogSupplement?.state === "needs_isbn" &&
              current.enrichment.catalogSupplement.owner === b.owner_id &&
              isbn13(current.isbn)
            )
              await enqueueCatalogSupplement(tx, b.owner_id, current);
          });
      const books = (
        await db.query(
          `SELECT ${bookSelect},owner_id FROM library_active_books b WHERE enrichment->'catalogSupplement'->>'scope'=$1 AND enrichment->'catalogSupplement'->>'state'='pending' AND coalesce((enrichment->'catalogSupplement'->>'nextAttemptAt')::bigint,0)<=$2 AND NOT EXISTS(SELECT 1 FROM library_documents d WHERE d.owner_id=b.owner_id AND d.book_id=b.id AND(d.processing_scope<>'full' OR d.material_kind~*'paper|periodical|journal|thesis')) ORDER BY created_at LIMIT 10`,
          [scope, Date.now()],
        )
      ).rows;
      for (const item of books) {
        if (!running) break;
        try {
          const book = await claimCatalogSupplement(
            db,
            item.owner_id,
            item.id,
            scope,
          );
          if (!book) continue;
          const work = book.enrichment.catalogSupplement;
          stats.checked++;
          const result = await collectSupplementRecords(work.isbn, lookup);
          const applied = await supplementBook(
            db,
            item.owner_id,
            book,
            result.records,
            result.retry,
          );
          if (applied.state === "complete") {
            stats.completed++;
            await reconcileCatalogReviews(
              db,
              item.owner_id,
              true,
              undefined,
              Infinity,
              item.id,
              result.records,
            );
          } else stats.pending++;
        } catch {
          stats.failed++;
        }
        await new Promise((r) => setTimeout(r, 1100));
      }
    } catch {
      stats.failed++;
    }
    try {
      await atomicWriteJson(join(dir, "status.json"), stats);
    } catch {
      console.error(
        "Catalog checkpoint temporarily unavailable; queued work is retained.",
      );
    }
    if (!process.argv.includes("--watch")) break;
    idleMs = stats.checked ? 60000 : Math.min(900000, idleMs * 2);
    await new Promise((r) => setTimeout(r, idleMs));
  } while (running);
} finally {
  release();
  await pool.end();
}
