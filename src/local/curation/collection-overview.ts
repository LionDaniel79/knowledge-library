import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { LogosCompletionBook } from "./logos-discovery";

type BookProgress = { id: string; applied?: boolean; state?: string | null };
export function summarizeCollectionBooks(
  books: BookProgress[],
  checkpoints = new Map<string, { state: string }>(),
) {
  const result = {
    total: 0,
    investigated: 0,
    applied: 0,
    remaining: 0,
    uninvestigated: 0,
    held: 0,
    holds: { review: 0, missing: 0, source: 0, retry: 0, other: 0 },
  };
  for (const b of new Map(books.map((b) => [b.id, b])).values()) {
    result.total++;
    const state = checkpoints.get(b.id)?.state || b.state;
    if (b.applied) {
      result.applied++;
      result.investigated++;
    } else if (state) {
      result.investigated++;
      result.held++;
      if (state === "review") result.holds.review++;
      else if (state === "missing") result.holds.missing++;
      else if (state === "source_unavailable") result.holds.source++;
      else if (
        ["error", "cover_failed", "deferred", "quarantined"].includes(state)
      )
        result.holds.retry++;
      else result.holds.other++;
    } else result.uninvestigated++;
  }
  result.remaining = result.total - result.applied;
  return result;
}

// Read existing per-book checkpoints only. Never scan PDF contents or alter a checkpoint.
export async function readPdfCollectionCheckpoints(
  cache: string,
  owner: string,
  ids: string[],
) {
  const dir = join(
    cache,
    "pdf-auto",
    "progress",
    createHash("sha256").update(owner).digest("hex"),
  );
  const result = new Map<string, { state: string }>();
  for (const id of ids) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw Error("Invalid book ID");
    try {
      const checkpoint = JSON.parse(
        await readFile(join(dir, id + ".json"), "utf8"),
      );
      if (typeof checkpoint.state !== "string" || !checkpoint.state)
        throw Error("Invalid checkpoint");
      result.set(id, { state: checkpoint.state });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return result;
}

export async function readLogosCollectionCheckpoints(
  cache: string,
  owner: string,
  books: { book: LogosCompletionBook; state?: string }[],
) {
  const dir = join(
    cache,
    "logos",
    createHash("sha256").update(owner).digest("hex"),
  );
  const result = new Map<string, { state: string }>();
  for (const { book, state } of books) {
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(["logos-completion/v1", owner, book]))
      .digest("hex");
    try {
      const checkpoint = JSON.parse(
        await readFile(join(dir, fingerprint + ".json"), "utf8"),
      );
      if (
        checkpoint.fingerprint !== fingerprint ||
        !Array.isArray(checkpoint.records)
      )
        throw Error("Invalid checkpoint");
      result.set(book.id, {
        state:
          checkpoint.lookupRetry || checkpoint.coverRetry
            ? "error"
            : state || "cached",
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return result;
}
