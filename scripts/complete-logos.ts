/** Finite operator run. No startup hook, watcher, or background polling. */
import { Pool } from "pg";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { createPoolDatabase } from "../src/server/sync/pool-database";
import { bookSelect } from "../src/server/book-records";
import {
  applyLogosCompletion,
  logosCompletionBook,
  logosCompletionFingerprint,
  resolveLogosOwner,
} from "../src/server/logos-completion";
import { logosLookup } from "../src/local/curation/logos-providers";
import { runLogosCompletion } from "../src/local/curation/logos-runner";
import { readCoverCapacity } from "../src/server/book-covers";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(
    "node --env-file=.env.local --import tsx scripts/complete-logos.ts [--online] [--apply] [--limit 30]\nDefault: cached preview only. Each finite run handles at most 100 resources; title discovery uses at most two provider requests per resource. Re-run to resume. SIGINT checkpoints after the current resource. No automatic ISBN assignment. Review uncertain covers at /logos/covers.",
  );
} else {
  const online = args.includes("--online"),
    apply = args.includes("--apply");
  const limit = args.includes("--limit")
    ? Number(args[args.indexOf("--limit") + 1])
    : 30;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw Error("한 번에 1~100개를 지정하세요.");
  if (
    !process.env.DATABASE_URL ||
    !process.env.LIBRARY_OWNER_EMAIL ||
    !process.env.CATALOG_CACHE_DIR
  )
    throw Error("소유자·DB·작업 저장 폴더 설정을 확인하세요.");
  if (apply && process.env.LIBRARY_STAGE5_WRITE_ENABLED !== "true")
    throw Error("운영 등록 허용 설정을 먼저 확인하세요.");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 15000,
    idleTimeoutMillis: 10000,
  });
  pool.on("error", () => {});
  const db = createPoolDatabase(pool),
    controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  try {
    const owner = await resolveLogosOwner(db, {
      id: process.env.LIBRARY_CATALOG_OWNER_ID,
      email: process.env.LIBRARY_OWNER_EMAIL,
    });
    const coverCapacity = await readCoverCapacity(db, owner);
    console.log(
      JSON.stringify({ preflight: "cover-storage", ...coverCapacity }),
    );
    if (
      apply &&
      (!coverCapacity.remainingAssets || !coverCapacity.remainingBytes)
    )
      throw Error("표지 저장 공간이 부족합니다. 저장 용량 검토 후 재개하세요.");
    const dir = join(
      resolve(process.env.CATALOG_CACHE_DIR),
      "logos",
      createHash("sha256").update(owner).digest("hex"),
    );
    const rows = (
      await db.query(
        `SELECT ${bookSelect} FROM library_active_books WHERE owner_id=$1 AND source_data->>'app'='Logos' ORDER BY id`,
        [owner],
      )
    ).rows;
    const books = rows
      .filter(
        (r) =>
          r.enrichment?.logosCompletion?.fingerprint !==
          logosCompletionFingerprint(logosCompletionBook(r)),
      )
      .map(logosCompletionBook);
    const stats = await runLogosCompletion({
      owner,
      dir,
      books,
      online,
      apply,
      limit,
      signal: controller.signal,
      lookup: logosLookup({
        dir: join(dir, "providers"),
        libraryKey: process.env.DATA4LIBRARY_KEY,
        yes24Key: process.env.YES24_API_KEY,
      }),
      applyDecision: (book, decision) =>
        applyLogosCompletion(db, owner, book, decision),
    });
    console.log(JSON.stringify(stats));
    if (["error", "quota"].includes(stats.stopped)) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
