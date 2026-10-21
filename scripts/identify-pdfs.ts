/** Explicit development task; reads the live OCR index without taking its writer lock. */
import { Pool } from "pg";
import { DatabaseSync } from "node:sqlite";
import { metadataPagesTable } from "../src/local/curation/pdf-metadata-pages";
import { createHash, randomUUID } from "node:crypto";
import { statSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { resolve, relative, isAbsolute, join } from "node:path";
import {
  extractPdfIdentity,
  resolvePdfIdentity,
  identitySearchQueries,
  identityFrontierReady,
  pdfIdentityFingerprint,
  reusableIdentityAttempt,
  type PdfIdentity,
  type IdentityPage,
} from "../src/local/curation/pdf-identity";
import { applyPdfIdentity } from "../src/local/curation/pdf-identity-store";
import { verifiedCurationOwner } from "../src/local/curation/owner";
import {
  lookupCollectedBook,
  type CollectedBook,
} from "../src/local/curation/catalog";
import { lookupLibraryTitle } from "../src/server/catalog-provider";
import type { Database } from "../src/server/library-store";

const args = process.argv.slice(2),
  online = args.includes("--online"),
  apply = args.includes("--apply"),
  readyOnly = args.includes("--ready-only"),
  isbnOnly = args.includes("--isbn-only");
const limit = args.includes("--limit")
  ? Number(args[args.indexOf("--limit") + 1])
  : 5000;
if (!Number.isInteger(limit) || limit < 1 || limit > 5000)
  throw Error("1~5000건을 지정하세요.");
if (apply && !online)
  throw Error("실제 보완은 --online --apply를 함께 지정하세요.");
const key = process.env.DATA4LIBRARY_KEY ?? "";
if (online && !key) throw Error("도서관 인증키가 필요합니다.");
const cacheRoot = resolve(
  process.env.CATALOG_CACHE_DIR || "private-data/catalog",
);
const resultDir = join(cacheRoot, "pdf-identity"),
  titleDir = join(cacheRoot, "title-search"),
  isbnDir = join(cacheRoot, "library");
await Promise.all(
  [resultDir, titleDir, isbnDir].map((p) => mkdir(p, { recursive: true })),
);
const local = new DatabaseSync(process.env.LIBRARY_PDF_INDEX!, {
  readOnly: true,
});
local.exec("PRAGMA busy_timeout=15000");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL_UNPOOLED,
  max: 1,
});
const db: Database = {
  query: (sql, p = []) => pool.query(sql, p),
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
const stats = {
  startedAt: new Date().toISOString(),
  online,
  apply,
  readyOnly,
  isbnOnly,
  deferred: 0,
  total: 0,
  processed: 0,
  resumed: 0,
  withIsbn: 0,
  pendingOcr: 0,
  waiting: 0,
  verified: 0,
  review: 0,
  notFound: 0,
  notQueried: 0,
  applied: 0,
  appliedBookIds: [] as string[],
  excluded: 0,
  sourceChanged: 0,
  requests: 0,
  stopped: "running",
};
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function save(path: string, value: unknown) {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temp, path);
}
async function cached(path: string): Promise<any | undefined> {
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
const pagesQuery = local.prepare(
  `SELECT page_number AS pageNumber,text,method FROM ${metadataPagesTable(local)} WHERE document_id=? AND page_number<=12 UNION ALL SELECT page_number AS pageNumber,text,method FROM ${metadataPagesTable(local)} WHERE document_id=? AND page_number>max(12,?) ORDER BY pageNumber`,
);
function readEvidence(d: any, book: any): PdfIdentity {
  return extractPdfIdentity(
    {
      id: d.id,
      title: book.title,
      author: book.author,
      signature: d.signature,
      sha256: d.sha256 ?? "",
      pageCount: Number(d.page_count),
      processingScope: d.processing_scope,
      status: d.status,
    },
    pagesQuery.all(
      d.id,
      d.id,
      Math.max(0, Number(d.page_count) - 8),
    ) as unknown as IdentityPage[],
  );
}
function sameFile(d: any) {
  try {
    const root = realpathSync(process.env.LIBRARY_PDF_ROOT!),
      file = realpathSync(d.path);
    const rel = relative(root, file),
      s = statSync(file, { bigint: true });
    return (
      !!rel &&
      rel !== ".." &&
      !rel.startsWith("..\\") &&
      !rel.startsWith("../") &&
      !isAbsolute(rel) &&
      s.size.toString() === String(d.bytes) &&
      s.mtimeNs.toString() === String(d.mtime_ns)
    );
  } catch {
    return false;
  }
}
async function lookupIsbn(isbn: string): Promise<CollectedBook | null> {
  const path = join(isbnDir, `${isbn}.json`),
    hit = await cached(path);
  if (
    hit &&
    typeof hit.retrievedAt === "string" &&
    (hit.record === null || hit.record?.isbn === isbn)
  )
    return hit.record;
  stats.requests++;
  const record = await lookupCollectedBook(isbn, "library", key);
  await save(path, { retrievedAt: new Date().toISOString(), record });
  await new Promise((r) => setTimeout(r, 1100));
  return record;
}
async function lookupTitle(title: string, author = "") {
  const path = join(
      titleDir,
      digest(author ? { title, author } : title) + ".json",
    ),
    hit = await cached(path);
  if (
    hit?.query === title &&
    (hit.author ?? "") === author &&
    Array.isArray(hit.result?.books)
  )
    return hit.result;
  stats.requests++;
  const result = await lookupLibraryTitle(title, key, author);
  await save(path, {
    query: title,
    author,
    retrievedAt: new Date().toISOString(),
    result,
  });
  await new Promise((r) => setTimeout(r, 1100));
  return result;
}
try {
  const owner = await verifiedCurationOwner(
    db,
    process.env.LIBRARY_OWNER_EMAIL,
  );
  const books = (
    await pool.query(
      "SELECT b.id,b.title,b.author,b.isbn,b.version,d.id AS document_id FROM library_active_books b JOIN library_documents d ON d.owner_id=b.owner_id AND d.book_id=b.id WHERE b.owner_id=$1 AND d.processing_scope='full' AND trim(b.isbn)='' ORDER BY b.id",
      [owner],
    )
  ).rows;
  stats.total = books.length;
  await save(join(resultDir, "status.json"), stats);
  const rows = [];
  for (const b of books) {
    if (stats.processed >= limit) {
      stats.stopped = "batch_limit";
      break;
    }
    const d = local
      .prepare("SELECT * FROM documents WHERE id=?")
      .get(b.document_id) as any;
    if (!d || !sameFile(d)) {
      stats.sourceChanged++;
      const result = {
        bookId: b.id,
        documentId: b.document_id,
        title: b.title,
        state: "source_changed",
        reason: "원본 파일 확인 필요",
        updatedAt: new Date().toISOString(),
      };
      await save(join(resultDir, `${b.document_id}.json`), result);
      rows.push(result);
      continue;
    }
    const evidence = readEvidence(d, b),
      fingerprint = pdfIdentityFingerprint(b.version, evidence);
    if (evidence.state === "excluded") {
      stats.excluded++;
      const result = {
        bookId: b.id,
        documentId: d.id,
        title: b.title,
        state: "excluded",
        reason: "원본 오류 또는 상세 처리 제외",
        updatedAt: new Date().toISOString(),
      };
      await save(join(resultDir, `${d.id}.json`), result);
      rows.push(result);
      continue;
    }
    const output = join(resultDir, `${d.id}.json`),
      previous = await cached(output);
    if (
      (readyOnly && !identityFrontierReady(evidence)) ||
      (isbnOnly && !evidence.candidates.length)
    ) {
      stats.deferred++;
      continue;
    }
    if (
      reusableIdentityAttempt(previous, {
        online,
        apply,
        isbnOnly,
        fingerprint,
      })
    ) {
      stats.resumed++;
      continue;
    }
    stats.processed++;
    if (evidence.candidates.length) stats.withIsbn++;
    if (evidence.unresolvedPages.length || evidence.missingPages.length)
      stats.pendingOcr++;
    const records: CollectedBook[] = [],
      titleResults: any[] = [];
    if (online) {
      // A large reference list must not fan out into an unbounded API job.
      for (const candidate of evidence.candidates.slice(0, 4)) {
        const record = await lookupIsbn(candidate.isbn);
        if (record) records.push(record);
      }
    }
    const resolution = resolvePdfIdentity(evidence, records);
    if (!online) {
      resolution.state = "not_queried";
      resolution.reason = "오프라인 조사 완료: 제공자 조회 전";
      stats.notQueried++;
    }
    if (online && !isbnOnly && resolution.state !== "verified") {
      // Title matches remain review candidates: no binding, translation, or edition is inferred.
      for (const query of identitySearchQueries(b.title, b.author)) {
        const found = await lookupTitle(query.title, query.author);
        titleResults.push({
          query: query.title,
          author: query.author,
          ...found,
        });
        if (found.books.length) break;
      }
      if (
        resolution.state !== "waiting_ocr" &&
        titleResults.some((r) => r.books.length)
      ) {
        resolution.state = "review";
        resolution.reason = "제목·저자 검색 후보: 판본 확인 필요";
      }
    }
    let applied = false,
      appliedVersion = b.version,
      skipReason = "";
    if (resolution.state === "verified") {
      stats.verified++;
      if (apply) {
        const result = await applyPdfIdentity(
          db,
          owner,
          b.id,
          b.version,
          evidence,
          resolution.record!,
          () => {
            const current = local
              .prepare("SELECT * FROM documents WHERE id=?")
              .get(d.id) as any;
            return (
              !!current &&
              sameFile(current) &&
              pdfIdentityFingerprint(b.version, readEvidence(current, b)) ===
                fingerprint
            );
          },
        );
        applied = result.applied;
        appliedVersion = result.version;
        skipReason = result.reason;
        if (applied) {
          stats.applied++;
          stats.appliedBookIds.push(b.id);
        }
      }
    } else if (resolution.state === "review") stats.review++;
    else if (resolution.state === "waiting_ocr") stats.waiting++;
    else if (online) stats.notFound++;
    const result = {
      version: 1,
      searchVersion: 2,
      isbnOnly,
      bookId: b.id,
      bookVersion: b.version,
      title: b.title,
      documentId: d.id,
      fingerprint,
      online,
      applied,
      appliedVersion,
      skipReason,
      evidence,
      records,
      titleResults,
      resolution,
      updatedAt: new Date().toISOString(),
    };
    await save(output, result);
    rows.push({
      title: b.title,
      documentId: d.id,
      state: resolution.state,
      candidates: evidence.candidates.map((c) => c.isbn),
      applied,
    });
    if (stats.processed % 10 === 0) {
      await save(join(resultDir, "status.json"), {
        ...stats,
        updatedAt: new Date().toISOString(),
      });
      console.log(JSON.stringify(stats));
    }
  }
  if (stats.stopped === "running") stats.stopped = "complete";
  await save(
    join(resultDir, online ? "online-summary.json" : "discovery-summary.json"),
    { ...stats, rows },
  );
} catch {
  stats.stopped = "error";
  process.exitCode = 1;
  console.error(
    "PDF 판본 수집 중단: 인증·한도·연결 및 저장 상태를 확인하세요. 캐시는 보존됩니다.",
  );
} finally {
  await save(join(resultDir, "status.json"), {
    ...stats,
    updatedAt: new Date().toISOString(),
  });
  local.close();
  await pool.end();
  console.log(JSON.stringify(stats));
}
