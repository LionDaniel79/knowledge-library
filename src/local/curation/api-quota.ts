import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

type Provider = "library" | "google" | "yes24";
interface QuotaOptions {
  path?: string;
  limit?: number;
  now?: number;
  ipRegistered?: boolean;
}
export class CatalogQuotaError extends Error {
  constructor(public readonly retryAt: string) {
    super(`서지 수집 호출 한도에 도달했습니다. 재개 가능 시각: ${retryAt}`);
  }
}

/** Reserve before sending, including failures. Cache hits must not call this.
 * All collectors on this PC must use the same file, including after a restart.
 * Rolling 24h is conservative across provider reset/time-zone differences. */
export function reserveCatalogRequest(
  provider: Provider,
  key: string,
  options: QuotaOptions = {},
) {
  const limit =
    options.limit ??
    Number(
      process.env[
        provider === "library"
          ? "DATA4LIBRARY_DAILY_LIMIT"
          : provider === "yes24"
            ? "YES24_DAILY_LIMIT"
            : "GOOGLE_BOOKS_DAILY_LIMIT"
      ] ?? (provider === "yes24" ? "20000" : "450"),
    );
  const ipRegistered =
    options.ipRegistered ?? process.env.DATA4LIBRARY_IP_REGISTERED === "true";
  if (
    !key ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100000 ||
    (provider === "library" && limit >= 500 && !ipRegistered)
  )
    throw Error(
      "서지 호출 한도 설정을 확인하세요. 500회 이상은 IP 등록 확인이 필요합니다.",
    );
  const now = options.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) throw Error("호출 시각 오류");
  const path =
    options.path ??
    process.env.CATALOG_API_USAGE_PATH ??
    resolve("private-data/catalog/api-usage.sqlite");
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec(
      "PRAGMA busy_timeout=10000; CREATE TABLE IF NOT EXISTS attempts (provider TEXT NOT NULL, credential_hash TEXT NOT NULL, attempted_ms INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS attempts_window ON attempts(provider,credential_hash,attempted_ms);",
    );
    db.exec("BEGIN IMMEDIATE");
    const hash = createHash("sha256").update(key).digest("hex");
    const row = db
      .prepare(
        "SELECT count(*) AS used,min(attempted_ms) AS earliest FROM attempts WHERE provider=? AND credential_hash=? AND attempted_ms>?",
      )
      .get(provider, hash, now - 86400000) as {
      used: number;
      earliest: number | null;
    };
    if (row.used >= limit)
      throw new CatalogQuotaError(
        new Date(Number(row.earliest) + 86400000).toISOString(),
      );
    db.prepare("INSERT INTO attempts VALUES(?,?,?)").run(provider, hash, now);
    db.exec("COMMIT");
    return { used: row.used + 1, limit, remaining: limit - row.used - 1 };
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}
