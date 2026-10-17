/** One finite, resumable image download. Images and links live in the online DB. */
import { Pool } from "pg";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { verifiedCurationOwner } from "../src/local/curation/owner";
import { acquireYes24Lock } from "../src/local/curation/yes24-batch";
import { atomicWriteJson } from "../src/local/atomic-json";
import { attachCatalogCoverSources } from "../src/server/book-records";
import { mirrorCover, storeCoverMirror } from "../src/server/cover-mirrors";
import { LibraryError, type Database } from "../src/server/library-store";
import type { Book } from "../src/lib/domain";
const args = process.argv.slice(2),
  arg = (s: string) =>
    args.includes(s) ? args[args.indexOf(s) + 1] : undefined;
if (!arg("--dir") || !args.includes("--apply"))
  throw Error("--dir 저장폴더 --apply가 필요합니다.");
const dir = resolve(arg("--dir")!),
  follow = arg("--follow-yes24"),
  max = Number(arg("--max-items") ?? Infinity);
if (!(max > 0)) throw Error("작업 범위를 확인하세요.");
await mkdir(dir, { recursive: true });
const release = acquireYes24Lock(join(dir, "worker-lock.sqlite"));
const pool = new Pool({
  connectionString: process.env.DATABASE_URL_UNPOOLED,
  max: 3,
  connectionTimeoutMillis: 15000,
  idleTimeoutMillis: 5000,
  keepAlive: true,
});
// An idle TLS disconnect must not terminate the whole finite batch.
pool.on("error", () => {});
pool.on("connect", (client) => client.on("error", () => {}));
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
const state = {
  pid: process.pid,
  startedAt: new Date().toISOString(),
  updatedAt: "",
  status: "running",
  targets: 0,
  saved: 0,
  failed: 0,
  attempts: 0,
  assetCount: 0,
  storedBytes: 0,
  errors: [] as { sourceHash: string; code: string }[],
};
const failures = new Map<string, number>();
let writes = Promise.resolve();
const save = () =>
  (writes = writes.then(async () => {
    state.updatedAt = new Date().toISOString();
    await atomicWriteJson(join(dir, "status.json"), state);
  }));
try {
  const owner = await verifiedCurationOwner(
    db,
    process.env.LIBRARY_OWNER_EMAIL,
  );
  let terminalSwept = false;
  while (state.attempts < max) {
    const books = (
      await db.query(
        `SELECT b.id,b.isbn,b.cover_url AS "coverUrl",b.source_data AS "sourceData" FROM library_active_books b WHERE b.owner_id=$1
   AND NOT EXISTS(SELECT 1 FROM library_documents d WHERE d.owner_id=b.owner_id AND d.book_id=b.id AND(d.processing_scope<>'full' OR d.material_kind~*'paper|periodical|journal|thesis'))
   AND(coalesce(b.source_data->>'app','')<>'Local PDF' OR EXISTS(SELECT 1 FROM library_documents d WHERE d.owner_id=b.owner_id AND d.book_id=b.id AND d.processing_scope='full'))`,
        [owner],
      )
    ).rows as Book[];
    await attachCatalogCoverSources(db, owner, books);
    const targets = new Set<string>();
    for (const b of books) {
      for (const url of [b.coverUrl, b.catalogCoverUrl])
        if (url?.startsWith("https://")) targets.add(url);
      const sha = b.sourceData?.cover?.sha256;
      if (sha && /^[a-f0-9]{64}$/.test(sha)) targets.add("import:" + sha);
    }
    const stored = new Set(
      (
        await db.query(
          "SELECT source FROM library_cover_mirrors WHERE owner_id=$1",
          [owner],
        )
      ).rows.map((r) => String(r.source)),
    );
    const pending = [...targets]
      .filter((s) => !stored.has(s) && (failures.get(s) ?? 0) < 3)
      .slice(0, max - state.attempts);
    state.targets = targets.size;
    state.saved = [...targets].filter((s) => stored.has(s)).length;
    await save();
    let cursor = 0;
    await Promise.all(
      Array.from({ length: 3 }, async () => {
        while (cursor < pending.length) {
          const source = pending[cursor++];
          state.attempts++;
          try {
            if (source.startsWith("import:")) {
              if (!process.env.LIBRARY_IMPORT_ASSET_DIR)
                throw new LibraryError(404, "import directory unavailable");
              const sha = source.slice(7),
                bytes = await readFile(
                  resolve(process.env.LIBRARY_IMPORT_ASSET_DIR, sha),
                );
              if (createHash("sha256").update(bytes).digest("hex") !== sha)
                throw new LibraryError(409, "import checksum mismatch");
              await storeCoverMirror(db, owner, source, bytes);
            } else await mirrorCover(db, owner, source);
            state.saved++;
            failures.delete(source);
          } catch (e) {
            const count =
              e instanceof LibraryError &&
              [400, 404, 409, 413].includes(e.status)
                ? 3
                : (failures.get(source) ?? 0) + 1;
            failures.set(source, count);
            state.errors.push({
              sourceHash: createHash("sha256").update(source).digest("hex"),
              code:
                e instanceof LibraryError ? String(e.status) : "DOWNLOAD_ERROR",
            });
            state.errors = state.errors.slice(-20);
          }
          state.failed = failures.size;
          await save();
          await new Promise((r) => setTimeout(r, 350));
        }
      }),
    );
    const usage = (
      await db.query(
        "SELECT count(*)::int n,coalesce(sum(length(data_base64)),0)::bigint bytes FROM library_cover_assets WHERE owner_id=$1",
        [owner],
      )
    ).rows[0];
    state.assetCount = usage.n;
    state.storedBytes = Number(usage.bytes);
    await save();
    if (state.attempts >= max) break;
    const canRetry = [...failures.values()].some((n) => n < 3);
    let collecting = false;
    if (follow) {
      const s = JSON.parse(
        await readFile(join(resolve(follow), "status.json"), "utf8"),
      );
      collecting = ["running", "waiting", "retrying"].includes(s.stopped);
    }
    if (!collecting && !terminalSwept) {
      terminalSwept = true;
      continue;
    }
    if (!collecting && !canRetry) break;
    state.status = "waiting";
    await save();
    await new Promise((r) => setTimeout(r, 30000));
    state.status = "running";
  }
  state.status = state.failed ? "completed_with_errors" : "completed";
  await save();
  console.log(JSON.stringify(state));
} catch (e) {
  state.status = "failed";
  state.errors.push({
    sourceHash: "",
    code:
      typeof (e as { code?: unknown })?.code === "string"
        ? String((e as { code: string }).code).slice(0, 30)
        : "WORKER_ERROR",
  });
  await save();
  console.error(
    "표지 작업이 중단되었습니다. 같은 저장폴더로 재개할 수 있습니다.",
  );
  process.exitCode = 1;
} finally {
  await pool.end();
  release();
}
