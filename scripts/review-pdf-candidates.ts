/** Extra discovery for unsuccessful filename searches. Never writes library books or PDFs. */
import { mkdir, readFile, readdir, writeFile, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { supplementalTitleQueries } from "../src/local/curation/supplemental-title-queries";
import { lookupLibraryTitle } from "../src/server/catalog-provider";
import { Pool } from "pg";
import { DatabaseSync } from "node:sqlite";
import { verifiedCurationOwner } from "../src/local/curation/owner";
import { candidateDiscoveryAllowed } from "../src/local/curation/review-scope";

const args = process.argv.slice(2);
const limit = Number(
  args.includes("--limit") ? args[args.indexOf("--limit") + 1] : 100,
);
if (!Number.isInteger(limit) || limit < 1 || limit > 5000)
  throw Error("1~5000건을 지정하세요.");
const online = args.includes("--online"),
  root = resolve(process.env.CATALOG_CACHE_DIR || "private-data/catalog");
const out = join(root, "supplemental-title-search"),
  titleDir = join(root, "title-search");
await mkdir(out, { recursive: true });
const digest = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
async function read(path: string): Promise<any> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if (
      e instanceof SyntaxError ||
      (e as NodeJS.ErrnoException).code === "ENOENT"
    )
      return undefined;
    throw e;
  }
}
async function save(path: string, value: unknown) {
  const temp = path + "." + randomUUID() + ".tmp";
  await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temp, path);
}
const stats = {
  total: 0,
  processed: 0,
  resumed: 0,
  candidatesFound: 0,
  requests: 0,
  cached: 0,
  stopped: "running",
  aiCalls: 0,
  bookWrites: 0,
};
const pool = new Pool({
  connectionString: process.env.DATABASE_URL_UNPOOLED,
  max: 1,
  connectionTimeoutMillis: 15000,
});
const local = new DatabaseSync(process.env.LIBRARY_PDF_INDEX!, {
  readOnly: true,
});
try {
  const owner = await verifiedCurationOwner(
    pool,
    process.env.LIBRARY_OWNER_EMAIL,
  );
  const files = (await readdir(join(root, "pdf-identity")))
    .filter((f) => /^[a-f\d-]+\.json$/.test(f))
    .sort();
  const rows: any[] = [];
  for (let i = 0; i < files.length; i += 16) {
    const batch = await Promise.all(
      files.slice(i, i + 16).map((f) => read(join(root, "pdf-identity", f))),
    );
    rows.push(
      ...batch.filter(
        (r) =>
          r?.resolution?.state === "not_found" &&
          r.evidence?.processingScope === "full" &&
          typeof r.title === "string" &&
          /^[a-f\d-]{36}$/.test(r.bookId) &&
          supplementalTitleQueries(r.title).length,
      ),
    );
  }
  stats.total = rows.length;
  for (const row of rows) {
    const current = (
      await pool.query(
        'SELECT b.id,b.owner_id,b.title,b.version,d.id AS "documentId",d.processing_scope FROM library_books b JOIN library_documents d ON d.owner_id=b.owner_id AND d.book_id=b.id WHERE b.owner_id=$1 AND b.id=$2 AND d.id=$3',
        [owner, row.bookId, row.documentId],
      )
    ).rows[0];
    if (
      !candidateDiscoveryAllowed(
        owner,
        row,
        current,
        local
          .prepare(
            "SELECT id,signature,processing_scope,status FROM documents WHERE id=?",
          )
          .get(row.documentId),
      )
    )
      continue;
    const queries = supplementalTitleQueries(row.title),
      fingerprint = digest([
        "supplemental-v2",
        owner,
        row.fingerprint,
        queries,
      ]);
    const path = join(out, row.bookId + ".json"),
      prior = await read(path);
    if (prior?.fingerprint === fingerprint && prior.complete) {
      stats.resumed++;
      continue;
    }
    if (stats.processed >= limit) {
      stats.stopped = "batch_limit";
      break;
    }
    const results = [];
    let complete = true;
    for (const q of queries) {
      const cache = join(titleDir, digest(q.author ? q : q.title) + ".json");
      let hit = await read(cache);
      if (
        hit?.query !== q.title ||
        (hit.author ?? "") !== q.author ||
        !Array.isArray(hit.result?.books)
      )
        hit = undefined;
      if (hit) stats.cached++;
      else {
        if (!online) {
          complete = false;
          continue;
        }
        if (!process.env.DATA4LIBRARY_KEY) throw Error("도서관 인증키 필요");
        const result = await lookupLibraryTitle(
          q.title,
          process.env.DATA4LIBRARY_KEY,
          q.author,
        );
        stats.requests++;
        hit = {
          query: q.title,
          author: q.author,
          retrievedAt: new Date().toISOString(),
          result,
        };
        await save(cache, hit);
        await new Promise((r) => setTimeout(r, 1100));
      }
      results.push(hit);
      if (hit.result.books.length) break;
    }
    stats.processed++;
    if (results.some((r) => r.result.books.length)) stats.candidatesFound++;
    await save(path, {
      bookId: row.bookId,
      documentId: row.documentId,
      title: row.title,
      bookVersion: row.bookVersion,
      fingerprint,
      complete,
      state: "review_only",
      results,
    });
    if (stats.processed % 10 === 0) {
      await save(join(out, "status.json"), {
        ...stats,
        updatedAt: new Date().toISOString(),
      });
      console.log(JSON.stringify(stats));
    }
  }
  if (stats.stopped === "running") stats.stopped = "complete";
} catch {
  stats.stopped = "error";
  process.exitCode = 1;
  console.error(
    "추가 제목 조회가 중단되었습니다. 키·한도·연결을 확인한 뒤 재실행하세요. 저장한 결과는 재사용합니다.",
  );
} finally {
  await save(join(out, "status.json"), {
    ...stats,
    updatedAt: new Date().toISOString(),
  });
  console.log(JSON.stringify(stats));
  local.close();
  await pool.end();
}
