import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Database } from "../../server/library-store";
import { isbn13 } from "../../lib/bibliography";
import { CatalogQuotaError } from "./api-quota";
import {
  collectBookReference,
  lookupCollectedBook,
  type CollectedBook,
} from "./catalog";

export async function runCatalogBatch(options: {
  db: Database;
  owner: string;
  books: { id: string; isbn: string; version: number }[];
  provider: "library" | "google";
  key: string;
  dir: string;
  online: boolean;
  apply: boolean;
  limit: number;
  delayMs?: number;
}) {
  const { db, owner, books, provider, key, dir, online, apply, limit } =
    options;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw Error("한 번에 1~100권을 지정하세요.");
  await mkdir(dir, { recursive: true });
  const stats = {
    considered: 0,
    requests: 0,
    matched: 0,
    missing: 0,
    applied: 0,
    cached: 0,
    pending: 0,
    stopped: "complete",
    retryAt: "",
  };
  async function save(path: string, value: unknown) {
    const temp = path + "." + randomUUID() + ".tmp";
    await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
    await rename(temp, path);
  }
  try {
    for (const book of books) {
      const isbn = isbn13(book.isbn);
      if (!isbn) continue;
      const path = join(dir, isbn + ".json");
      let cached:
        { retrievedAt: string; record: CollectedBook | null } | undefined;
      try {
        const value = JSON.parse(await readFile(path, "utf8"));
        if (
          typeof value.retrievedAt === "string" &&
          (value.record === null || value.record?.isbn === isbn)
        )
          cached = value;
      } catch (e) {
        if (
          !(e instanceof SyntaxError) &&
          (e as NodeJS.ErrnoException).code !== "ENOENT"
        )
          throw e;
      }
      if (cached) stats.cached++;
      if (!cached) {
        if (!online || stats.requests >= limit) {
          stats.pending++;
          continue;
        }
        stats.requests++;
        const record = await lookupCollectedBook(isbn, provider, key);
        cached = { retrievedAt: new Date().toISOString(), record };
        await save(path, cached);
        await new Promise((r) => setTimeout(r, options.delayMs ?? 1100));
      }
      if (!cached.record) {
        stats.missing++;
        continue;
      }
      if (stats.considered >= limit) {
        stats.pending++;
        continue;
      }
      stats.considered++;
      stats.matched++;
      const result = await collectBookReference(
        db,
        owner,
        { kind: "book", id: book.id, version: String(book.version) },
        cached.record,
        apply,
      );
      stats.applied += result.applied;
    }
    return stats;
  } catch (error) {
    stats.stopped = error instanceof CatalogQuotaError ? "quota" : "error";
    if (error instanceof CatalogQuotaError) {
      stats.requests--;
      stats.retryAt = error.retryAt;
    }
    // Provider and DB exceptions can carry URLs or user records. Do not persist them.
    throw error instanceof CatalogQuotaError
      ? error
      : Error(
          "서지 수집이 중단되었습니다. 승인·연결 상태를 확인한 뒤 같은 명령으로 재개하세요.",
        );
  } finally {
    await save(join(dir, "status.json"), {
      ...stats,
      updatedAt: new Date().toISOString(),
      online,
      apply,
    });
  }
}
