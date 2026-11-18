/** Read-only collection overview. No provider calls, OCR, or library writes. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import {
  runtimeEnvironment,
  unlockProfile,
} from "../desktop/windows/runtime-profile.mjs";
import { atomicWriteJson } from "../src/local/atomic-json";
import { logosCompletionBook } from "../src/server/logos-completion";
import {
  summarizeCollectionBooks,
  readPdfCollectionCheckpoints,
  readLogosCollectionCheckpoints,
} from "../src/local/curation/collection-overview";
const read = async (path: string) =>
  JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
const config = await read(process.argv[process.argv.indexOf("--config") + 1]);
let pool: Pool | undefined;
try {
  const runtime = await read(config.runtimeConfiguration);
  const env: Record<string, string> = runtimeEnvironment(
    runtime,
    unlockProfile(runtime),
  );
  pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 15000,
    statement_timeout: 20000,
    options: "-c default_transaction_read_only=on",
  });
  const owner =
    env.LIBRARY_CATALOG_OWNER_ID ||
    (
      await pool.query(
        'SELECT id::text FROM neon_auth."user" WHERE lower(email)=lower($1)',
        [env.LIBRARY_OWNER_EMAIL],
      )
    ).rows[0]?.id;
  if (!owner) throw Error("Missing owner");
  const rows = (
    await pool.query(
      `SELECT id,title,author,publisher,isbn,version,
      jsonb_build_object('recordId',source_data->'recordId','raw',jsonb_build_object('publicationDate',source_data->'raw'->'publicationDate','edition',source_data->'raw'->'edition','resourceType',source_data->'raw'->'resourceType')) AS "sourceData",source_data->>'app' AS app,
    (enrichment->'autoBibliography'->>'appliedAt' IS NOT NULL OR
      (enrichment->'logosCompletion'->>'state'='certain' AND cover_url<>'')) IS TRUE AS applied,
    enrichment->'logosCompletion'->>'state' AS state
    FROM library_active_books WHERE owner_id=$1 AND
      (source_data->>'app'='Logos' OR (source_data->>'app'='Local PDF' AND 'pdf'=ANY(formats)))`,
      [owner],
    )
  ).rows;
  const pdf = rows.filter((b) => b.app === "Local PDF"),
    logos = rows.filter((b) => b.app === "Logos");
  const checkpoints = await readPdfCollectionCheckpoints(
    env.CATALOG_CACHE_DIR,
    owner,
    pdf.map((b) => b.id),
  );
  const logosCheckpoints = await readLogosCollectionCheckpoints(
    env.CATALOG_CACHE_DIR,
    owner,
    logos.map((row) => ({ book: logosCompletionBook(row), state: row.state })),
  );
  await atomicWriteJson(join(config.stateDirectory, "overview.json"), {
    version: 1,
    at: new Date().toISOString(),
    pdf: summarizeCollectionBooks(pdf, checkpoints),
    logos: summarizeCollectionBooks(logos, logosCheckpoints),
  });
  await atomicWriteJson(join(config.stateDirectory, "overview-refresh.json"), {
    at: new Date().toISOString(),
    ok: true,
  });
} catch {
  await atomicWriteJson(join(config.stateDirectory, "overview-refresh.json"), {
    at: new Date().toISOString(),
    ok: false,
  });
  process.exitCode = 1;
} finally {
  await pool?.end();
}
