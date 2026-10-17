/** One finite enrichment job. Resume the same --dir; no recurring scheduler. */
import { Pool } from "pg";
import { createHash } from "node:crypto";
import { mkdir, readFile, access } from "node:fs/promises";
import { atomicWriteJson } from "../src/local/atomic-json";
import { join, resolve } from "node:path";
import { isbn13 } from "../src/lib/bibliography";
import { verifiedCurationOwner } from "../src/local/curation/owner";
import {
  reserveCatalogRequest,
  CatalogQuotaError,
} from "../src/local/curation/api-quota";
import { supplementalTitleQueries } from "../src/local/curation/supplemental-title-queries";
import {
  parseYes24Records,
  parseYes24Toc,
  readYes24Response,
  Yes24RequestError,
  verifiedYes24Match,
  applyYes24Supplement,
  runYes24Queue,
  runYes24Retries,
  acquireYes24Lock,
} from "../src/local/curation/yes24-batch";
import { importCatalogReview } from "../src/server/catalog-review-store";
import { precheckCatalogReviews } from "../src/local/curation/catalog-precheck";
import type { CollectedBook } from "../src/local/curation/catalog";
import type { Database } from "../src/server/library-store";

const args = process.argv.slice(2),
  arg = (k: string) =>
    args.includes(k) ? args[args.indexOf(k) + 1] : undefined;
const output = arg("--dir"),
  maxItems = arg("--max-items") ? Number(arg("--max-items")) : undefined;
if (
  !output ||
  !args.includes("--apply") ||
  (maxItems !== undefined && (!Number.isInteger(maxItems) || maxItems < 1))
)
  throw Error("--dir 저장폴더 --apply [--max-items 표본권수]를 지정하세요.");
const dir = resolve(output),
  key = process.env.YES24_API_KEY;
if (!key) throw Error("예스24 API 키가 설정되어 있지 않습니다.");
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
async function save(path: string, value: unknown) {
  await atomicWriteJson(path, value);
}
async function read(path: string): Promise<any | null> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
await mkdir(join(dir, "cache"), { recursive: true });
await mkdir(join(dir, "results"), { recursive: true });
const usagePath =
  process.env.CATALOG_API_USAGE_PATH ??
  resolve(
    process.env.CATALOG_CACHE_DIR ?? "private-data/catalog",
    "api-usage.sqlite",
  );
const releaseLock = acquireYes24Lock(usagePath);
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
let state: any = {
  cursor: 0,
  waitUntil: null,
  requests: 0,
  cached: 0,
  counts: {},
  appliedItems: 0,
  startedAt: new Date().toISOString(),
};
const stateSave = async () =>
  save(join(dir, "status.json"), {
    ...state,
    pid: process.pid,
    updatedAt: new Date().toISOString(),
  });
let lastRequest = Date.now();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function checkStop() {
  try {
    await access(join(dir, "STOP"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  throw new Yes24RequestError(0, "USER_STOP");
}
async function request<T>(
  endpoint: string,
  params: Record<string, string>,
  parse: (json: any) => T,
): Promise<T | null> {
  await checkStop();
  const url = new URL("https://apis.yes24.com/v1/goods/" + endpoint);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const file = join(dir, "cache", digest(url.href) + ".json"),
    cached = await read(file);
  if (cached) {
    state.cached++;
    return cached.value;
  }
  await sleep(Math.max(0, 1100 - (Date.now() - lastRequest)));
  reserveCatalogRequest("yes24", key!, {
    path: usagePath,
    limit: Math.min(20000, Number(process.env.YES24_DAILY_LIMIT ?? 20000)),
  });
  state.requests++;
  await stateSave();
  let response: Response;
  try {
    lastRequest = Date.now();
    response = await fetch(url, {
      headers: { "X-Api-Key": key! },
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new Yes24RequestError(0, "NETWORK_ERROR");
  }
  const raw = await readYes24Response(response),
    value = raw === null ? null : parse(raw);
  await save(file, {
    retrievedAt: new Date().toISOString(),
    endpoint,
    query: params.query,
    value,
  });
  return value;
}
async function fingerprint(owner: string) {
  const notes = (
    await db.query(
      "SELECT count(*)::int AS count,md5(string_agg(md5(to_jsonb(n)::text),'' ORDER BY id)) AS fingerprint FROM library_notes n WHERE owner_id=$1",
      [owner],
    )
  ).rows[0];
  const cycles = (
    await db.query(
      "SELECT count(*)::int AS count,md5(string_agg(md5(to_jsonb(c)::text),'' ORDER BY id)) AS fingerprint FROM library_cycles c WHERE owner_id=$1",
      [owner],
    )
  ).rows[0];
  return { notes, cycles };
}
try {
  state = (await read(join(dir, "status.json"))) ?? state;
  delete state.finishedAt;
  delete state.after;
  const owner = await verifiedCurationOwner(
    db,
    process.env.LIBRARY_OWNER_EMAIL,
  );
  let job = await read(join(dir, "job.json"));
  if (!job) {
    const books = (
      await db.query(
        `SELECT b.id,b.title,b.author,b.publisher,b.isbn,b.version FROM library_active_books b WHERE b.owner_id=$1
      AND NOT EXISTS(SELECT 1 FROM library_documents d WHERE d.owner_id=b.owner_id AND d.book_id=b.id AND (d.processing_scope<>'full' OR d.material_kind ~* 'paper|periodical|journal|thesis'))
      AND (coalesce(b.source_data->>'app','')<>'Local PDF' OR EXISTS(SELECT 1 FROM library_documents d WHERE d.owner_id=b.owner_id AND d.book_id=b.id AND d.processing_scope='full')) ORDER BY b.title,b.id`,
        [owner],
      )
    ).rows;
    books.sort(
      (a, b) =>
        Number(!!isbn13(b.isbn)) - Number(!!isbn13(a.isbn)) ||
        a.title.localeCompare(b.title, "ko"),
    );
    job = {
      ownerHash: digest(owner),
      batchSize: 2000,
      gapMs: 600000,
      books,
      before: await fingerprint(owner),
      createdAt: new Date().toISOString(),
    };
    await save(join(dir, "job.json"), job);
  }
  if (
    job.ownerHash !== digest(owner) ||
    job.batchSize !== 2000 ||
    job.gapMs !== 600000
  )
    throw Error("작업 소유자 또는 설정 불일치");
  state.total = job.books.length;
  state.stopped = "running";
  state.batchSize = job.batchSize;
  state.gapMinutes = 10;
  state.errorCode = null;
  await stateSave();
  const processBook = async (book: any) => {
    await checkStop();
    state.stopped = "running";
    state.currentBookId = book.id;
    const current = (
      await db.query(
        "SELECT version FROM library_active_books WHERE owner_id=$1 AND id=$2",
        [owner, book.id],
      )
    ).rows[0];
    let records: CollectedBook[] = [],
      result: any = { status: "not_found", applied: 0 };
    if (!current || Number(current.version) !== book.version)
      result = { status: "changed", applied: 0 };
    else {
      const isbn = isbn13(book.isbn);
      if (isbn)
        records =
          (await request(
            "itemDetail",
            { searchType: "ISBN13", query: isbn, detail: "Y" },
            (j) => parseYes24Records(j, isbn),
          )) ?? [];
      const verified = records.filter((r) => verifiedYes24Match(book, r));
      if (verified.length === 1) {
        const record = verified[0];
        const hasToc =
          (
            await db.query(
              "SELECT id FROM library_curation_items WHERE owner_id=$1 AND source_kind='book' AND source_id=$2 AND source_version=$3 AND kind='toc' AND state IN ('active','hidden') LIMIT 1",
              [owner, book.id, String(book.version)],
            )
          ).rows.length > 0;
        if (!hasToc && !record.toc?.length) {
          const itemId = record.url.split("/").pop()!;
          const toc = await request(
            "content",
            { searchType: "ItemId", query: itemId },
            (j) => {
              if (
                String(j?.data?.data?.itemId) !== itemId ||
                typeof j?.data?.data?.contents !== "string"
              )
                throw new Yes24RequestError(200, "INVALID_TOC");
              return parseYes24Toc(j.data.data.contents);
            },
          );
          if (toc) record.toc = toc;
        }
        result = await applyYes24Supplement(db, owner, book, record);
      } else {
        const title = String(book.title)
          .normalize("NFKC")
          .replace(/\.pdf$/i, "")
          .trim();
        const hints = supplementalTitleQueries(title);
        const queries = [
          `${title} ${book.author ?? ""}`.trim(),
          title,
          ...hints.slice(0, 2).map((h) => `${h.title} ${h.author}`.trim()),
        ];
        for (const query of [...new Set(queries)]
          .filter((q) => q.length >= 2 && q.length <= 200)
          .slice(0, 3)) {
          if (records.length) break;
          records =
            (await request(
              "itemList",
              {
                query,
                pageSize: "10",
                category: "ALL",
                detail: "Y",
                sort: "RELATION",
              },
              (j) => parseYes24Records(j),
            )) ?? [];
        }
        result = {
          status: records.length ? "review_required" : "not_found",
          applied: 0,
        };
      }
    }
    await save(join(dir, "results", book.id + ".json"), {
      bookId: book.id,
      title: book.title,
      sourceVersion: book.version,
      ...result,
      records,
      collectedAt: new Date().toISOString(),
    });
    if (result.status === "review_required")
      for (const record of records) {
        try {
          await importCatalogReview(db, owner, {
            bookId: book.id,
            sourceVersion: book.version,
            record,
          });
        } catch (e) {
          if ((e as Error).name !== "ZodError") throw e;
          state.invalidCandidates = (state.invalidCandidates ?? 0) + 1;
        }
      }
    state.consecutiveFailures = 0;
    if (result.status === "review_required") {
      const checked = await precheckCatalogReviews(db, owner, true, book.id);
      state.precheckedBooks = (state.precheckedBooks ?? 0) + checked.applied;
    }
    state.counts[result.status] = (state.counts[result.status] ?? 0) + 1;
    state.appliedItems += result.applied;
  };
  await runYes24Queue({
    items: job.books,
    state,
    batchSize: job.batchSize,
    gapMs: job.gapMs,
    maxItems,
    sleep: async (ms) => {
      await checkStop();
      await sleep(ms);
    },
    save: async () => {
      state.stopped = state.waitUntil ? "waiting" : "running";
      await stateSave();
      if (state.cursor % 25 === 0)
        console.log(
          JSON.stringify({
            processed: state.cursor,
            total: state.total,
            requests: state.requests,
            counts: state.counts,
            waitUntil: state.waitUntil,
          }),
        );
    },
    onTransientError: async (book: any, error) => {
      state.consecutiveFailures = (state.consecutiveFailures ?? 0) + 1;
      await save(join(dir, "results", book.id + ".json"), {
        bookId: book.id,
        sourceVersion: book.version,
        status: "retry_later",
        errorCode: error.code,
        collectedAt: new Date().toISOString(),
      });
      state.counts.retry_later = (state.counts.retry_later ?? 0) + 1;
      if (state.consecutiveFailures >= 3) throw error;
    },
    process: processBook,
  });
  if (state.cursor === state.total) {
    const pending: string[] = [];
    for (const b of job.books) {
      const result = await read(join(dir, "results", b.id + ".json"));
      if (result?.status === "retry_later") pending.push(b.id);
    }
    if (!state.retry || args.includes("--retry-failed"))
      state.retry = { pending, pass: 0, remaining: 0, waitUntil: null };
    const byId = new Map(job.books.map((b: any) => [b.id, b]));
    state.stopped = "retrying";
    await runYes24Retries({
      state: state.retry,
      gapMs: 600000,
      maxPasses: 3,
      sleep: async (ms) => {
        await checkStop();
        await sleep(ms);
      },
      save: stateSave,
      process: async (id) => {
        await checkStop();
        const prior = await read(join(dir, "results", id + ".json"));
        if (prior?.status !== "retry_later") return;
        await processBook(byId.get(id));
        state.counts.retry_later = Math.max(
          0,
          (state.counts.retry_later ?? 0) - 1,
        );
      },
    });
    state.stopped = state.retry.pending.length ? "retry_pending" : "complete";
  } else state.stopped = "sample_complete";
  state.after = await fingerprint(owner);
  state.finishedAt = new Date().toISOString();
} catch (e) {
  state.stopped = e instanceof CatalogQuotaError ? "quota" : "error";
  state.errorCode =
    e instanceof Yes24RequestError
      ? e.code
      : e instanceof CatalogQuotaError
        ? "LOCAL_QUOTA"
        : "WORKER_ERROR";
  state.httpStatus = e instanceof Yes24RequestError ? e.status : null;
  if (e instanceof CatalogQuotaError) state.retryAt = e.retryAt;
  process.exitCode = 1;
} finally {
  try {
    await stateSave();
    await pool.end();
  } finally {
    releaseLock();
  }
  console.log(JSON.stringify(state));
}
