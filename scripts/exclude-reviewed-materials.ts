// Operator-only: the web API exposes restoration, never bulk exclusion.
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Pool } from "pg";
import { z } from "zod";
import { createBookExclusionStore } from "../src/server/book-exclusions";
import type { Database } from "../src/server/library-store";
const args = process.argv.slice(2),
  option = (name: string) => {
    const i = args.indexOf(name);
    return i < 0 ? undefined : args[i + 1];
  };
const manifestPath = option("--manifest");
if (!manifestPath) throw Error("--manifest is required");
if (!process.env.DATABASE_URL_UNPOOLED || !process.env.LIBRARY_OWNER_EMAIL)
  throw Error("Private operator configuration required");
const source = z
  .object({
    createdAt: z.string(),
    items: z
      .array(
        z.object({
          id: z.string().uuid(),
          version: z.number().int().positive(),
          document_id: z.string().uuid(),
          material_kind: z.enum(["paper", "periodical"]),
        }),
      )
      .length(5208),
  })
  .parse(JSON.parse(await readFile(manifestPath, "utf8")));
const counts = {
  paper: source.items.filter((x) => x.material_kind === "paper").length,
  periodical: source.items.filter((x) => x.material_kind === "periodical")
    .length,
};
if (
  counts.paper !== 2609 ||
  counts.periodical !== 2599 ||
  new Set(source.items.map((x) => x.id)).size !== 5208
)
  throw Error(
    "The approved selection must contain exactly 2,609 papers and 2,599 periodicals",
  );
const target = new URL(process.env.DATABASE_URL_UNPOOLED);
if (option("--target-host")) target.hostname = option("--target-host")!;
if (target.hostname.includes("-pooler"))
  throw Error("A direct operator connection is required");
const apply = args.includes("--apply"),
  pool = new Pool({
    connectionString: target.href,
    max: 1,
    connectionTimeoutMillis: 15000,
  });
const client = await pool.connect();
try {
  await client.query(
    "BEGIN ISOLATION LEVEL REPEATABLE READ" + (apply ? "" : " READ ONLY"),
  );
  await client.query("SET LOCAL lock_timeout='5s'");
  await client.query("SET LOCAL statement_timeout='90s'");
  const owner = (
    await client.query(
      'SELECT id::text FROM neon_auth."user" WHERE lower(email)=lower($1) AND "emailVerified"=true',
      [process.env.LIBRARY_OWNER_EMAIL],
    )
  ).rows;
  if (owner.length !== 1)
    throw Error("Exactly one verified library owner is required");
  const ownerId = owner[0].id,
    ids = source.items.map((x) => x.id);
  const items = source.items
    .map((x) => ({
      id: x.id,
      expectedVersion: x.version,
      kind: x.material_kind,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        "approved-material-exclusion",
        ownerId,
        source.createdAt,
        items,
      ]),
    )
    .digest("hex");
  const requestId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  const replay =
    (
      await client.query(
        "SELECT request_id FROM library_operations WHERE owner_id=$1 AND request_id=$2",
        [ownerId, requestId],
      )
    ).rows.length > 0;
  const documents = (
    await client.query(
      "SELECT id,book_id,material_kind FROM library_documents WHERE owner_id=$1 AND id=ANY($2::uuid[])",
      [ownerId, source.items.map((x) => x.document_id)],
    )
  ).rows;
  const map = new Map(documents.map((x) => [x.id, x]));
  if (
    source.items.some(
      (x) =>
        map.get(x.document_id)?.book_id !== x.id ||
        map.get(x.document_id)?.material_kind !== x.material_kind,
    )
  )
    throw Error("Approved document identities/classifications changed");
  const deferred = (
    await client.query(
      "SELECT d.id,b.id AS book_id,b.version FROM library_documents d JOIN library_active_books b ON b.owner_id=d.owner_id AND b.id=d.book_id WHERE d.owner_id=$1 AND d.material_kind='review' ORDER BY d.id",
      [ownerId],
    )
  ).rows;
  if (deferred.length !== 37)
    throw Error("The 37 deferred documents must remain active");
  const existing = Number(
    (
      await client.query(
        "SELECT count(*) FROM library_book_exclusions WHERE owner_id=$1 AND id=ANY($2::uuid[])",
        [ownerId, ids],
      )
    ).rows[0].count,
  );
  if (existing && !replay)
    throw Error(
      "Selection already contains exclusion/restoration decisions; refusing to overwrite them",
    );
  async function retained() {
    const result: Record<string, unknown> = {};
    for (const table of [
      "library_books",
      "library_documents",
      "library_notes",
      "library_cycles",
    ])
      result[table] = (
        await client.query(
          `SELECT count(*)::int AS total,md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' ORDER BY id),'')) AS digest FROM ${table} t WHERE owner_id=$1`,
          [ownerId],
        )
      ).rows[0];
    return result;
  }
  const before = await retained(),
    activeBefore = Number(
      (
        await client.query(
          "SELECT count(*) FROM library_active_books WHERE owner_id=$1",
          [ownerId],
        )
      ).rows[0].count,
    );
  let result: unknown = null;
  if (apply) {
    const db: Database = {
      query: (sql, params = []) => client.query(sql, params),
      transaction: async (fn) =>
        fn({ query: (sql, params = []) => client.query(sql, params) }),
    };
    result = await createBookExclusionStore(db).exclude(ownerId, {
      requestId,
      items,
    });
  }
  const after = await retained(),
    activeAfter = Number(
      (
        await client.query(
          "SELECT count(*) FROM library_active_books WHERE owner_id=$1",
          [ownerId],
        )
      ).rows[0].count,
    );
  const excluded = Number(
    (
      await client.query(
        "SELECT count(*) FROM library_book_exclusions WHERE owner_id=$1 AND state='excluded' AND id=ANY($2::uuid[])",
        [ownerId, ids],
      )
    ).rows[0].count,
  );
  const deferredAfter = (
    await client.query(
      "SELECT d.id,b.id AS book_id,b.version FROM library_documents d JOIN library_active_books b ON b.owner_id=d.owner_id AND b.id=d.book_id WHERE d.owner_id=$1 AND d.material_kind='review' ORDER BY d.id",
      [ownerId],
    )
  ).rows;
  if (
    JSON.stringify(before) !== JSON.stringify(after) ||
    JSON.stringify(deferred) !== JSON.stringify(deferredAfter)
  )
    throw Error("Retained records changed; transaction cancelled");
  if (
    apply &&
    !replay &&
    (excluded !== 5208 || activeBefore - activeAfter !== 5208)
  )
    throw Error("Exclusion count mismatch; transaction cancelled");
  await client.query("COMMIT");
  const report = {
    host: target.hostname,
    apply,
    replay,
    requestId,
    approved: counts,
    excluded,
    activeBefore,
    activeAfter,
    deferred: deferred.length,
    retained: after,
    originalFilesTouched: false,
    result,
  };
  if (option("--report"))
    await writeFile(option("--report")!, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  console.error(
    JSON.stringify({
      errorCode: (error as { code?: string }).code ?? "validation_failed",
      message: (error as Error).message,
    }),
  );
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
