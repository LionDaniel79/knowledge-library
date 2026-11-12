import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteJson } from "../atomic-json";
import { acquireYes24Lock } from "./yes24-batch";
import { CatalogQuotaError } from "./api-quota";
import {
  decideLogosCandidate,
  type LogosCandidate,
  type LogosCompletionBook,
} from "./logos-discovery";

type Decision = ReturnType<typeof decideLogosCandidate>;
export async function runLogosCompletion(options: {
  owner: string;
  dir: string;
  books: LogosCompletionBook[];
  online: boolean;
  apply: boolean;
  limit: number;
  signal?: AbortSignal;
  now?: () => number;
  lookup: (book: LogosCompletionBook) => Promise<LogosCandidate[]>;
  applyDecision: (
    book: LogosCompletionBook,
    decision: Decision,
  ) => Promise<"complete" | "stale" | "excluded" | "cover_failed">;
  decide?: typeof decideLogosCandidate;
  onInvestigated?: (book: LogosCompletionBook) => void;
}) {
  if (
    !options.owner ||
    !Number.isInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 100
  )
    throw Error("소유자와 한 번에 1~100개인 작업 범위를 확인하세요.");
  await mkdir(options.dir, { recursive: true });
  const release = acquireYes24Lock(join(options.dir, "worker.sqlite"));
  const stats = {
    considered: 0,
    requests: 0,
    cached: 0,
    certain: 0,
    review: 0,
    missing: 0,
    applied: 0,
    failed: 0,
    deferred: 0,
    quarantined: 0,
    pending: 0,
    stopped: "complete",
    retryAt: "",
  };
  const hash = (value: unknown) =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const now = options.now ?? Date.now;
  function retryAt(at: number) {
    const iso = new Date(at).toISOString();
    if (!stats.retryAt || iso < stats.retryAt) stats.retryAt = iso;
  }
  let activeIndex = 0;
  try {
    for (const [index, book] of options.books.entries()) {
      activeIndex = index;
      if (options.signal?.aborted) {
        stats.stopped = "paused";
        stats.pending += options.books.length - index;
        break;
      }
      const fingerprint = hash(["logos-completion/v1", options.owner, book]);
      const path = join(options.dir, fingerprint + ".json");
      let checkpoint:
        | {
            fingerprint: string;
            records: LogosCandidate[];
            applied?: boolean;
            coverRetry?: { attempts: number; nextAttemptAt: number };
            lookupRetry?: { attempts: number; nextAttemptAt: number };
          }
        | undefined;
      try {
        checkpoint = JSON.parse(await readFile(path, "utf8"));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      if (
        checkpoint &&
        (checkpoint.fingerprint !== fingerprint ||
          !Array.isArray(checkpoint.records))
      )
        throw Error("서지 작업 기록 형식을 확인하세요.");
      for (const retry of [checkpoint?.coverRetry, checkpoint?.lookupRetry])
        if (
          retry &&
          (!Number.isSafeInteger(retry.attempts) ||
            retry.attempts < 1 ||
            !Number.isSafeInteger(retry.nextAttemptAt) ||
            retry.nextAttemptAt < 0)
        )
          throw Error("서지 재시도 기록 형식을 확인하세요.");
      if (checkpoint?.lookupRetry && checkpoint.applied)
        throw Error("서지 재시도 기록 형식을 확인하세요.");
      if (
        checkpoint &&
        !checkpoint.lookupRetry &&
        (!options.apply || checkpoint.applied)
      ) {
        stats.cached++;
        stats[decideLogosCandidate(book, checkpoint.records).state]++;
        continue;
      }
      if (checkpoint?.lookupRetry && checkpoint.lookupRetry.attempts >= 3) {
        stats.quarantined++;
        stats.pending++;
        continue;
      }
      if (
        checkpoint?.lookupRetry &&
        checkpoint.lookupRetry.nextAttemptAt > now()
      ) {
        stats.deferred++;
        stats.pending++;
        retryAt(checkpoint.lookupRetry.nextAttemptAt);
        continue;
      }
      // Three failed image attempts require a manual cover choice. Keeping this
      // checkpoint prevents a broken first URL from starving later finite runs.
      if (checkpoint?.coverRetry && checkpoint.coverRetry.attempts >= 3) {
        stats.quarantined++;
        stats.pending++;
        continue;
      }
      if (
        checkpoint?.coverRetry &&
        checkpoint.coverRetry.nextAttemptAt > now()
      ) {
        stats.deferred++;
        stats.pending++;
        retryAt(checkpoint.coverRetry.nextAttemptAt);
        continue;
      }
      if (stats.considered >= options.limit) {
        stats.pending++;
        continue;
      }
      if (!checkpoint || checkpoint.lookupRetry) {
        if (!options.online || stats.requests >= options.limit) {
          stats.pending++;
          continue;
        }
        stats.requests++;
        try {
          checkpoint = { fingerprint, records: await options.lookup(book) };
        } catch (error) {
          // A malformed provider JSON response belongs to this resource. Never
          // apply an empty result for it, leak the payload, or block later books.
          // Quota and other service-wide failures retain the existing safe stop.
          if (
            !(error instanceof SyntaxError) &&
            ![400, 404, 422].includes(
              (error as { status?: number })?.status ?? 0,
            )
          )
            throw error;
          const attempts = (checkpoint?.lookupRetry?.attempts ?? 0) + 1;
          const nextAttemptAt =
            attempts >= 3 ? 0 : now() + 60000 * 2 ** (attempts - 1);
          checkpoint = {
            fingerprint,
            records: [],
            lookupRetry: { attempts, nextAttemptAt },
          };
          await atomicWriteJson(path, checkpoint);
          stats.considered++;
          options.onInvestigated?.(book);
          stats.failed++;
          stats.pending++;
          if (attempts >= 3) stats.quarantined++;
          else retryAt(nextAttemptAt);
          continue;
        }
        await atomicWriteJson(path, checkpoint);
      }
      stats.considered++;
      options.onInvestigated?.(book);
      const decision = (options.decide ?? decideLogosCandidate)(
        book,
        checkpoint.records,
      );
      stats[decision.state]++;
      if (options.apply && !checkpoint.applied) {
        const state = await options.applyDecision(book, decision);
        if (state === "complete") {
          checkpoint.applied = true;
          delete checkpoint.coverRetry;
          await atomicWriteJson(path, checkpoint);
          stats.applied++;
        } else if (state === "cover_failed") {
          const attempts = (checkpoint.coverRetry?.attempts ?? 0) + 1;
          const nextAttemptAt =
            attempts >= 3 ? 0 : now() + 60000 * 2 ** (attempts - 1);
          checkpoint.coverRetry = { attempts, nextAttemptAt };
          await atomicWriteJson(path, checkpoint);
          stats.failed++;
          stats.pending++;
          if (attempts >= 3) stats.quarantined++;
          else retryAt(nextAttemptAt);
        } else stats.pending++;
      }
    }
  } catch (error) {
    stats.stopped = error instanceof CatalogQuotaError ? "quota" : "error";
    if (error instanceof CatalogQuotaError) stats.retryAt = error.retryAt;
    // Neither provider exceptions nor credentials are serialized to disk/logs.
    stats.pending += options.books.length - activeIndex;
  } finally {
    try {
      await atomicWriteJson(join(options.dir, "status.json"), {
        ...stats,
        updatedAt: new Date().toISOString(),
      });
    } finally {
      release();
    }
  }
  return stats;
}
