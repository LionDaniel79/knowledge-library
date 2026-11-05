import { withSyncWrite } from "../../server/sync/write";
import { isbn13 } from "../../lib/bibliography";
import { providerText } from "../../lib/provider-text";
import { secureImage } from "../../server/catalog-provider";
import { classificationTitleMatches } from "./verified-metadata-match";
import { collectBookReference, type CollectedBook } from "./catalog";
import type { Database } from "../../server/library-store";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

function textField(value: unknown) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string")
    throw new Yes24RequestError(200, "INVALID_TEXT_FIELD");
  return value;
}

export function parseYes24Toc(value: unknown): string[] {
  return textField(value)
    .replace(/<(?:br\b[^>]*|\/(?:p|div|li|h[1-6]))\s*>/gi, "\n")
    .split(/\r?\n/)
    .map(providerText)
    .filter(Boolean)
    .map((s) => s.slice(0, 300))
    .slice(0, 200);
}

export function parseYes24Records(
  json: any,
  requestedIsbn = "",
  includeTextualPeriodicals = false,
): CollectedBook[] {
  if (json?.success !== true || !Array.isArray(json?.data?.items))
    throw Error("예스24 응답 형식을 확인해야 합니다.");
  const requested = requestedIsbn ? isbn13(requestedIsbn) : "";
  if (requestedIsbn && !requested) return [];
  return json.data.items.slice(0, 20).flatMap((b: any): CollectedBook[] => {
    const isbn = isbn13(textField(b.isbn13 || b.isbn10 || ""));
    for (const value of [
      b.title,
      b.author,
      b.publisher,
      b.cover,
      b.contentDetail?.bookIntroduction,
    ])
      textField(value);
    const kind = String(b.goodsSortNm ?? "");
    if (
      !/^\d+$/.test(String(b.itemId)) ||
      !providerText(b.title) ||
      !isbn ||
      (requested && requested !== isbn) ||
      (!includeTextualPeriodicals &&
        /잡지|간행물|논문|magazine|journal|periodical|thesis/i.test(kind))
    )
      return [];
    return [
      {
        provider: "예스24",
        url: `https://www.yes24.com/product/goods/${b.itemId}`,
        isbn,
        title: providerText(b.title).slice(0, 300),
        facts: {
          title: providerText(b.title).slice(0, 300),
          author: providerText(b.author).slice(0, 300),
          publisher: providerText(b.publisher).slice(0, 300),
          isbn,
          coverUrl: secureImage(b.cover),
        },
        description: providerText(b.contentDetail?.bookIntroduction).slice(
          0,
          500,
        ),
        descriptionFormat: "plain-text-v1",
        toc: parseYes24Toc(b.contentDetail?.tableOfContents),
      },
    ];
  });
}

export class Yes24RequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(`예스24 요청 중단: HTTP ${status}, ${code}`);
  }
}
function transientRequest(error: unknown): error is Yes24RequestError {
  return (
    error instanceof Yes24RequestError &&
    ([502, 503, 504].includes(error.status) ||
      (error.status === 0 && error.code === "NETWORK_ERROR"))
  );
}
export async function readYes24Response(
  response: Response,
): Promise<any | null> {
  let json: any;
  try {
    json = await response.json();
  } catch {
    throw new Yes24RequestError(response.status, "INVALID_RESPONSE");
  }
  const code = /^[A-Z0-9_]{1,50}$/.test(String(json?.errorCode))
    ? String(json.errorCode)
    : "REQUEST_FAILED";
  if (
    response.status === 404 &&
    ["SEARCH_001", "GOODS_001", "GOODS_002"].includes(code)
  )
    return null;
  if (!response.ok || json?.success !== true)
    throw new Yes24RequestError(response.status, code);
  return json;
}

export function verifiedYes24Match(
  book: { title: string; isbn: string; author?: string; publisher?: string },
  record: CollectedBook,
) {
  return !!record && classificationTitleMatches(book, record.facts);
}

export function batchWaitUntil(
  processed: number,
  total: number,
  batchSize: number,
  now: number,
  gapMs: number,
) {
  if (
    !Number.isInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 2000 ||
    gapMs < 0
  )
    throw Error("묶음 설정 오류");
  return processed > 0 && processed < total && processed % batchSize === 0
    ? now + gapMs
    : null;
}

export async function applyYes24Supplement(
  db: Database,
  owner: string,
  expected: { id: string; version: number },
  record: CollectedBook,
) {
  return withSyncWrite(db, owner, async (tx) => {
    const skip = (status: string) => ({ status, applied: 0 });
    const book = (
      await tx.query(
        "SELECT * FROM library_books WHERE owner_id=$1 AND id=$2 FOR UPDATE",
        [owner, expected.id],
      )
    ).rows[0];
    if (!book || Number(book.version) !== expected.version)
      return skip("changed");
    const docs = (
      await tx.query(
        "SELECT processing_scope,material_kind FROM library_documents WHERE owner_id=$1 AND book_id=$2",
        [owner, expected.id],
      )
    ).rows;
    if (
      (book.source_data?.app === "Local PDF" && !docs.length) ||
      docs.some(
        (d) =>
          d.processing_scope !== "full" ||
          /paper|periodical|journal|thesis/i.test(d.material_kind),
      )
    )
      return skip("excluded");
    if (
      !verifiedYes24Match(
        {
          title: book.title,
          isbn: book.isbn,
          author: book.author,
          publisher: book.publisher,
        },
        record,
      )
    )
      return skip("review_required");
    const existing = (
      await tx.query(
        "SELECT kind,value,state,reviewed_by FROM library_curation_items WHERE owner_id=$1 AND source_kind='book' AND source_id=$2 AND source_version=$3 AND state<>'rolled_back'",
        [owner, expected.id, String(expected.version)],
      )
    ).rows;
    if (existing.some((c) => c.reviewed_by || c.state === "hidden"))
      return skip("human_reviewed");
    const has = (kind: string) =>
      existing.some((c) => c.kind === kind && c.state === "active");
    const cover =
      !book.cover_url &&
      !book.source_data?.cover &&
      !existing.some((c) => c.kind === "bibliography" && c.value?.coverUrl);
    const filtered: CollectedBook = {
      ...record,
      facts: { ...record.facts, coverUrl: cover ? record.facts.coverUrl : "" },
      toc: has("toc") ? [] : record.toc,
      description:
        has("description") || has("publisher_intro") ? "" : record.description,
    };
    if (
      has("bibliography") &&
      !filtered.facts.coverUrl &&
      !filtered.toc?.length &&
      !filtered.description
    )
      return skip("already_present");
    const result = await collectBookReference(
      { query: tx.query, transaction: (fn) => fn(tx) },
      owner,
      { kind: "book", id: expected.id, version: String(expected.version) },
      filtered,
      true,
    );
    return {
      status: result.applied ? "applied" : "already_present",
      applied: result.applied,
      runId: result.runId,
    };
  });
}

export async function runYes24Queue<T>(options: {
  items: T[];
  state: { cursor: number; waitUntil: number | null };
  batchSize: number;
  gapMs: number;
  process: (item: T) => Promise<void>;
  onTransientError?: (item: T, error: Yes24RequestError) => Promise<void>;
  save: () => Promise<void>;
  maxItems?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}) {
  const { items, state, batchSize, gapMs } = options;
  const now = options.now ?? Date.now,
    sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let processed = 0;
  while (
    state.cursor < items.length &&
    processed < (options.maxItems ?? Infinity)
  ) {
    while (state.waitUntil && now() < state.waitUntil)
      await sleep(Math.min(30000, state.waitUntil - now()));
    state.waitUntil = null;
    try {
      await options.process(items[state.cursor]);
    } catch (e) {
      if (!transientRequest(e) || !options.onTransientError) throw e;
      await options.onTransientError(items[state.cursor], e);
    }
    state.cursor++;
    processed++;
    state.waitUntil = batchWaitUntil(
      state.cursor,
      items.length,
      batchSize,
      now(),
      gapMs,
    );
    await options.save();
  }
}

/** Persisted finite retries. Authentication/quota failures always stop the job. */
export async function runYes24Retries(options: {
  state: {
    pending: string[];
    pass: number;
    remaining: number;
    waitUntil: number | null;
  };
  process: (id: string) => Promise<void>;
  save: () => Promise<void>;
  gapMs: number;
  maxPasses: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}) {
  const { state } = options,
    now = options.now ?? Date.now,
    sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  while (state.pending.length) {
    if (!state.remaining) {
      if (state.pass >= options.maxPasses) break;
      state.pass++;
      state.remaining = state.pending.length;
      state.waitUntil = now() + options.gapMs;
      await options.save();
    }
    while (state.waitUntil && now() < state.waitUntil)
      await sleep(Math.min(30000, state.waitUntil - now()));
    state.waitUntil = null;
    const id = state.pending[0];
    let failed = false;
    try {
      await options.process(id);
    } catch (e) {
      if (!transientRequest(e)) throw e;
      failed = true;
    }
    state.pending.shift();
    if (failed) state.pending.push(id);
    state.remaining--;
    await options.save();
  }
  return { complete: state.pending.length === 0 };
}

/** SQLite serializes ownership checks. A dead process cannot leave a permanent file lock. */
export function acquireYes24Lock(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const token = randomUUID(),
    db = new DatabaseSync(path);
  try {
    db.exec(
      "PRAGMA busy_timeout=10000;CREATE TABLE IF NOT EXISTS yes24_worker_lock(id INTEGER PRIMARY KEY CHECK(id=1),pid INTEGER NOT NULL,token TEXT NOT NULL);BEGIN IMMEDIATE",
    );
    const prior = db
      .prepare("SELECT pid FROM yes24_worker_lock WHERE id=1")
      .get() as { pid: number } | undefined;
    if (prior) {
      let alive = true;
      try {
        process.kill(prior.pid, 0);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ESRCH") alive = false;
        else throw e;
      }
      if (alive) throw Error("다른 예스24 수집 작업이 실행 중입니다.");
    }
    db.prepare(
      "INSERT INTO yes24_worker_lock VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET pid=excluded.pid,token=excluded.token",
    ).run(process.pid, token);
    db.exec("COMMIT");
  } catch (e) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw e;
  } finally {
    db.close();
  }
  return () => {
    const db = new DatabaseSync(path);
    try {
      db.exec("PRAGMA busy_timeout=10000");
      db.prepare("DELETE FROM yes24_worker_lock WHERE id=1 AND token=?").run(
        token,
      );
    } finally {
      db.close();
    }
  };
}
