import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { testDatabase } from "./helpers/database";
import { withSyncWrite } from "../src/server/sync/write";
let f: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  f = await testDatabase();
});
afterAll(async () => {
  await f?.pg.close();
});
async function add(owner: string, id = randomUUID()) {
  await f.db.query(
    "INSERT INTO library_books(id,owner_id,title,formats) VALUES($1,$2,'원본',ARRAY['paper'])",
    [id, owner],
  );
  return id;
}
const changes = async (owner: string) =>
  (
    await f.db.query(
      "SELECT revision::text,entity,record_key,action FROM library_sync_changes WHERE owner_id=$1 ORDER BY revision",
      [owner],
    )
  ).rows;
it("records insert, real changes and deletion in the same transaction without duplicate no-op events", async () => {
  const owner = randomUUID(),
    id = await add(owner);
  await f.db.query(
    "UPDATE library_books SET title=title WHERE owner_id=$1 AND id=$2",
    [owner, id],
  );
  await f.db.query(
    "UPDATE library_books SET title='수정' WHERE owner_id=$1 AND id=$2",
    [owner, id],
  );
  await f.db.query("DELETE FROM library_books WHERE owner_id=$1 AND id=$2", [
    owner,
    id,
  ]);
  expect(await changes(owner)).toMatchObject([
    {
      revision: "1",
      entity: "library_books",
      record_key: JSON.stringify([id]),
      action: "upsert",
    },
    { revision: "2", action: "upsert" },
    { revision: "3", action: "delete" },
  ]);
  expect(
    (
      await f.db.query(
        "SELECT revision::text,deleted,value_sha256,value_bytes::int FROM library_sync_row_versions WHERE owner_id=$1",
        [owner],
      )
    ).rows,
  ).toEqual([
    { revision: "3", deleted: true, value_sha256: null, value_bytes: 0 },
  ]);
});
it("rolls back both business rows and cursor changes; other owners are isolated", async () => {
  const owner = randomUUID(),
    other = randomUUID();
  await add(other);
  await expect(
    withSyncWrite(f.db, owner, async (tx) => {
      await tx.query(
        "INSERT INTO library_books(id,owner_id,title,formats) VALUES($1,$2,'취소',ARRAY['paper'])",
        [randomUUID(), owner],
      );
      throw Error("cancel");
    }),
  ).rejects.toThrow("cancel");
  expect(await changes(owner)).toEqual([]);
  expect(
    (
      await f.db.query("SELECT id FROM library_books WHERE owner_id=$1", [
        owner,
      ])
    ).rows,
  ).toEqual([]);
  expect(await changes(other)).toHaveLength(1);
});
it("tracks public device fields but not token rotations and never stores secrets in the journal", async () => {
  const owner = randomUUID(),
    id = randomUUID();
  await f.db.query(
    "INSERT INTO library_analysis_devices(id,owner_id,name,token_hash,expires_at) VALUES($1,$2,'PC',$3,now()+interval '1 day')",
    [id, owner, "private-" + id],
  );
  await f.db.query(
    "UPDATE library_analysis_devices SET token_hash=$3 WHERE owner_id=$1 AND id=$2",
    [owner, id, "rotated-" + id],
  );
  expect(await changes(owner)).toHaveLength(1);
  await f.db.query(
    "UPDATE library_analysis_devices SET name='iPhone' WHERE owner_id=$1 AND id=$2",
    [owner, id],
  );
  expect(await changes(owner)).toHaveLength(2);
  expect(JSON.stringify(await changes(owner))).not.toContain("private-");
});
it("tracks composite and owner-only keys and handles primary-key moves without a stale old row", async () => {
  const owner = randomUUID();
  await f.db.query(
    "INSERT INTO library_annual_metrics(owner_id,year,reported_books,source,explanation) VALUES($1,2026,25.5,'test','test')",
    [owner],
  );
  await f.db.query("INSERT INTO library_ai_policy(owner_id) VALUES($1)", [
    owner,
  ]);
  const id = await add(owner),
    next = randomUUID();
  await f.db.query(
    "UPDATE library_books SET id=$3 WHERE owner_id=$1 AND id=$2",
    [owner, id, next],
  );
  const events = await changes(owner);
  expect(events[0].record_key).toBe('["2026"]');
  expect(events[1].record_key).toBe("[]");
  expect(events.slice(-2)).toMatchObject([
    { record_key: JSON.stringify([id]), action: "delete" },
    { record_key: JSON.stringify([next]), action: "upsert" },
  ]);
});
it("restricted runtime can write through tracking without reading credentials or gaining broad deletes", async () => {
  await f.pg.exec(
    await readFile("db/operations/provision-web-runtime.sql", "utf8"),
  );
  await f.pg.exec("SET SESSION AUTHORIZATION library_web_runtime");
  try {
    const owner = randomUUID();
    await withSyncWrite(f.db, owner, async (tx) => {
      await tx.query(
        "INSERT INTO library_books(id,owner_id,title,formats) VALUES($1,$2,'원본',ARRAY['paper'])",
        [randomUUID(), owner],
      );
    });
    expect(await changes(owner)).toHaveLength(1);
    await expect(f.db.query("DELETE FROM library_books")).rejects.toThrow();
    await expect(
      f.db.query('SELECT * FROM neon_auth."user"'),
    ).rejects.toThrow();
  } finally {
    await f.pg.exec("RESET SESSION AUTHORIZATION");
  }
});
