/** Read-only operational snapshot; personal record bodies are never printed. */
import { Pool } from "pg";
import { DatabaseSync } from "node:sqlite";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
const args = process.argv.slice(2),
  arg = (n: string) =>
    args.includes(n) ? args[args.indexOf(n) + 1] : undefined;
if (!arg("--baseline") || !arg("--output"))
  throw Error("--baseline 백업과 --output 검수 파일을 지정하세요.");
const baseline = JSON.parse(await readFile(arg("--baseline")!, "utf8"));
const pool = new Pool({
  connectionString: process.env.DATABASE_URL_UNPOOLED,
  max: 1,
  connectionTimeoutMillis: 15000,
});
const local = new DatabaseSync(process.env.LIBRARY_PDF_INDEX!, {
  readOnly: true,
});
local.exec("PRAGMA busy_timeout=5000");
const hash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
try {
  const c = await pool.connect();
  try {
    await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    const owner = (
      await c.query(
        'SELECT id::text FROM neon_auth."user" WHERE lower(email)=lower($1)',
        [process.env.LIBRARY_OWNER_EMAIL],
      )
    ).rows[0]?.id;
    if (!owner) throw Error("서재 소유자 확인 필요");
    const preservation: Record<string, unknown> = {};
    let intact = true;
    for (const table of ["library_notes", "library_cycles"]) {
      const rows = (
        await c.query(
          `SELECT to_jsonb(t)-'owner_id' AS row FROM ${table} t WHERE owner_id=$1 ORDER BY id`,
          [owner],
        )
      ).rows.map((r) => r.row);
      const same =
        JSON.stringify(rows) === JSON.stringify(baseline.tables[table]);
      intact &&= same;
      preservation[table] = {
        count: rows.length,
        unchanged: same,
        sha256: hash(rows),
      };
    }
    const books = (
      await c.query(
        `SELECT coalesce(source_data->>'app','manual') source,count(*)::int total,count(nullif(isbn,''))::int with_isbn,count(nullif(author,''))::int with_author,count(nullif(publisher,''))::int with_publisher,count(nullif(category,''))::int with_category,count(nullif(cover_url,''))::int direct_cover FROM library_books WHERE owner_id=$1 GROUP BY 1`,
        [owner],
      )
    ).rows;
    const auxiliary = (
      await c.query(
        `SELECT c.kind,c.origin,count(*)::int total,count(*) FILTER(WHERE c.state='active' AND c.source_version=b.version::text)::int current FROM library_curation_items c LEFT JOIN library_books b ON b.owner_id=c.owner_id AND c.source_id=b.id::text AND c.source_kind='book' WHERE c.owner_id=$1 GROUP BY c.kind,c.origin ORDER BY 1,2`,
        [owner],
      )
    ).rows;
    const covers = (
      await c.query(
        `SELECT count(DISTINCT b.id)::int n FROM library_books b JOIN library_curation_items c ON c.owner_id=b.owner_id AND c.source_id=b.id::text AND c.source_kind='book' AND c.source_version=b.version::text JOIN library_reference_sources r ON r.owner_id=c.owner_id AND r.id::text=c.evidence->>'referenceId' AND r.source_version=c.source_version WHERE b.owner_id=$1 AND c.state='active' AND c.kind='bibliography' AND c.origin='provider' AND r.edition_match='isbn' AND coalesce(c.value->>'coverUrl','')<>'' AND b.isbn=c.value->>'isbn'`,
        [owner],
      )
    ).rows[0].n;
    await c.query("COMMIT");
    const identity: Record<string, number> = {},
      dir = join(process.env.CATALOG_CACHE_DIR!, "pdf-identity");
    for (const name of await readdir(dir))
      if (/^[0-9a-f-]{36}\.json$/.test(name)) {
        const v = JSON.parse(await readFile(join(dir, name), "utf8"));
        const state = v.resolution?.state ?? v.state ?? "unknown";
        identity[state] = (identity[state] ?? 0) + 1;
      }
    const report = {
      at: new Date().toISOString(),
      preservation,
      books,
      auxiliary,
      verifiedProviderCovers: covers,
      pdfScope: local
        .prepare(
          "SELECT processing_scope,material_kind,count(*) total FROM documents GROUP BY 1,2",
        )
        .all(),
      pdfMethods: local
        .prepare(
          "SELECT p.method,count(*) total FROM documents d JOIN pages p ON p.document_id=d.id WHERE d.processing_scope='full' GROUP BY p.method",
        )
        .all(),
      identityCache: identity,
    };
    await writeFile(arg("--output")!, JSON.stringify(report, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
    console.log(JSON.stringify(report, null, 2));
    if (!intact)
      throw Error(
        "기준 백업 이후 기록 변경이 있습니다. 자동 덮어쓰기 없이 변경 이유를 검토하세요.",
      );
  } finally {
    c.release();
  }
} finally {
  local.close();
  await pool.end();
}
