/** Only an explicitly selected disposable database. Never defaults to DATABASE_URL. */
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { Pool } from "pg";
import { createPoolDatabase } from "../src/server/sync/pool-database";
import { withSyncWrite } from "../src/server/sync/write";
import { readSyncCoverage } from "../src/server/sync/coverage";
import {
  readSyncMeta,
  readSyncChanges,
  scanSyncRows,
} from "../src/server/sync/read";
import { createSyncCursor, type SyncRow } from "../src/lib/replica/contracts";
import { syncEntities, type SyncEntity } from "../src/lib/replica/entities";
const url = new URL(
  process.env.SYNC_VERIFY_DATABASE_URL ?? "https://not-configured.invalid",
);
const production = process.env.DATABASE_URL
  ? new URL(process.env.DATABASE_URL).hostname.replace("-pooler", "")
  : "";
if (
  !["postgres:", "postgresql:"].includes(url.protocol) ||
  !process.env.SYNC_VERIFY_BRANCH_ID ||
  url.hostname !== process.env.SYNC_VERIFY_ALLOWED_HOST ||
  url.hostname.replace("-pooler", "") === production
)
  throw Error(
    "A separate disposable branch and its exact allowed host are required",
  );
const pool = new Pool({
    connectionString: url.href,
    max: 4,
    statement_timeout: 20000,
  }),
  db = createPoolDatabase(pool),
  owner = "sync-race-" + randomUUID();
const ids = [1, 2, 8].map(
  (n) => n.toString(16).padStart(8, "0") + "-" + randomUUID().slice(9),
);
const sourceOwner = process.env.LIBRARY_OWNER_EMAIL
  ? (
      await pool.query(
        'SELECT id::text FROM neon_auth."user" WHERE lower(email)=lower($1)',
        [process.env.LIBRARY_OWNER_EMAIL],
      )
    ).rows[0]?.id
  : undefined;
async function retained() {
  const result: Record<string, unknown> = {};
  if (!sourceOwner) return result;
  for (const table of [
    "library_books",
    "library_documents",
    "library_notes",
    "library_cycles",
  ])
    result[table] = (
      await pool.query(
        `SELECT count(*)::int AS count,md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' ORDER BY id),'')) AS digest FROM ${table} t WHERE owner_id=$1`,
        [sourceOwner],
      )
    ).rows[0];
  return result;
}
try {
  const before = await retained();
  await withSyncWrite(db, owner, async (tx) => {
    for (const id of ids.slice(1))
      await tx.query(
        "INSERT INTO library_books(id,owner_id,title,formats) VALUES($1,$2,'검증 전',ARRAY['paper'])",
        [id, owner],
      );
  });
  const meta = await readSyncMeta(db, owner),
    map = new Map<string, SyncRow>();
  const stage = (rows: SyncRow[]) => {
    for (const row of rows) {
      const key = row.entity + "\0" + row.key,
        old = map.get(key);
      if (!old || BigInt(old.revision) <= BigInt(row.revision))
        map.set(key, row);
    }
  };
  const first = await scanSyncRows(db, owner, {
    entity: "library_books",
    limit: 1,
  });
  stage(first.rows);
  const writer = await pool.connect();
  try {
    await writer.query("BEGIN");
    await writer.query("SELECT library_sync_lock($1)", [owner]);
    await writer.query(
      "UPDATE library_books SET title='검증 후' WHERE owner_id=$1 AND id=$2",
      [owner, ids[1]],
    );
    assert.equal(
      (await readSyncCoverage(db, owner)).head,
      meta.head,
      "Uncommitted writer leaked into coverage",
    );
    await writer.query("COMMIT");
  } finally {
    await writer.query("ROLLBACK").catch(() => {});
    writer.release();
  }
  await withSyncWrite(db, owner, async (tx) => {
    await tx.query(
      "INSERT INTO library_books(id,owner_id,title,formats) VALUES($1,$2,'이미 스캔한 범위',ARRAY['paper'])",
      [ids[0], owner],
    );
    await tx.query("DELETE FROM library_books WHERE owner_id=$1 AND id=$2", [
      owner,
      ids[2],
    ]);
  });
  let after = first.cursor;
  while (true) {
    const p = await scanSyncRows(db, owner, {
      entity: "library_books",
      after,
      limit: 1,
    });
    stage(p.rows);
    after = p.cursor;
    if (!p.hasMore) break;
  }
  for (const entity of Object.keys(syncEntities) as SyncEntity[])
    if (entity !== "library_books")
      stage((await scanSyncRows(db, owner, { entity })).rows);
  let cursor = createSyncCursor({ owner, epoch: meta.epoch, after: meta.head }),
    head = meta.head;
  for (let i = 0; i < 50; i++) {
    const p = await readSyncChanges(db, owner, {
      epoch: meta.epoch,
      cursor,
      limit: 1,
    });
    stage(p.rows);
    cursor = p.cursor;
    head = p.head;
    if (!p.hasMore) break;
  }
  const coverage = await readSyncCoverage(db, owner);
  assert.equal(head, coverage.head);
  for (const entity of Object.keys(syncEntities) as SyncEntity[]) {
    const rows = [...map.values()]
      .filter((r) => r.entity === entity && !r.deleted)
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const sha256 = createHash("sha256")
      .update(rows.map((r) => r.key + "\t" + r.sha256 + "\n").join(""))
      .digest("hex");
    assert.deepEqual({ rows: rows.length, sha256 }, coverage.entities[entity]);
  }
  assert.deepEqual(
    await retained(),
    before,
    "Existing library content changed",
  );
  console.log(
    JSON.stringify({
      branch: process.env.SYNC_VERIFY_BRANCH_ID,
      entities: Object.keys(coverage.entities).length,
      committedChangesOnly: true,
      concurrentCoverageConsistent: true,
      scanAndDeltaMatch: true,
      existingDataPreserved: true,
    }),
  );
} finally {
  await pool.end();
}
