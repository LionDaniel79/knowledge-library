/** Read-only cloud export followed by a restore into a NEW local database. */
import { Pool } from "pg";
import { PGlite } from "@electric-sql/pglite";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, resolve, join } from "node:path";
import {
  createLibraryBackup,
  restoreLibraryBackup,
} from "../src/server/library-backup";
import type { Database } from "../src/server/library-store";
const args = process.argv.slice(2),
  value = args[args.indexOf("--output") + 1];
if (!args.includes("--output") || !value || !isAbsolute(value))
  throw Error("새 외장하드 검수 경로를 --output으로 지정하세요.");
const out = resolve(value);
if (existsSync(out))
  throw Error("기존 검수 경로를 덮어쓰지 않습니다. 새 경로를 지정하세요.");
await mkdir(out, { recursive: true });
const pool = new Pool({
  connectionString: process.env.DATABASE_URL_UNPOOLED,
  max: 1,
  connectionTimeoutMillis: 15000,
});
const cloud: Database = {
  query: (s, p = []) => pool.query(s, p),
  transaction: async (fn) => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN READ ONLY");
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
let pg: PGlite | undefined;
try {
  const input = args.includes("--input")
    ? args[args.indexOf("--input") + 1]
    : undefined;
  const owners = input
    ? []
    : (await cloud.query("SELECT DISTINCT owner_id FROM library_books")).rows;
  if (!input && owners.length !== 1)
    throw Error("검수할 서재 소유자를 하나로 확인할 수 없습니다.");
  const backup = input
    ? JSON.parse(await readFile(input, "utf8"))
    : await createLibraryBackup(cloud, owners[0].owner_id);
  await writeFile(join(out, "library-backup.json"), JSON.stringify(backup), {
    flag: "wx",
    mode: 0o600,
  });
  console.log(
    "Cloud read-only export saved. Restoring into a new local database.",
  );
  // The Windows file-backed adapter fails during initialization on this host.
  // Keep the temporary database in memory; the durable export and report stay on E:.
  pg = new PGlite();
  for (const f of (await readdir("db"))
    .filter((f) => /^\d+.*\.sql$/.test(f))
    .sort())
    await pg.exec(await readFile(join("db", f), "utf8"));
  const local: Database = {
    query: (s, p = []) => pg!.query(s, p),
    transaction: (fn) =>
      pg!.transaction((tx) => fn({ query: (s, p = []) => tx.query(s, p) })),
  };
  const result = await restoreLibraryBackup(local, "restore-rehearsal", backup);
  const after = await createLibraryBackup(local, "restore-rehearsal");
  const failures = Object.keys(backup.tables).filter(
    (k) =>
      JSON.stringify(backup.tables[k as keyof typeof backup.tables]) !==
      JSON.stringify(after.tables[k as keyof typeof after.tables]),
  );
  const report = {
    at: new Date().toISOString(),
    tableCount: Object.keys(backup.tables).length,
    counts: result.counts,
    mismatchedTables: failures,
    cloudWrites: 0,
    temporaryDatabase: "memory",
    independentPhysicalBackup: false,
  };
  await writeFile(
    join(out, "rehearsal-summary.json"),
    JSON.stringify(report, null, 2),
    { flag: "wx" },
  );
  console.log(JSON.stringify(report));
  if (failures.length) throw Error("복원 전후 차이가 있습니다.");
} finally {
  await pg?.close();
  await pool.end();
}
