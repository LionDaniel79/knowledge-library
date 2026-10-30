import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { projectSyncRow } from "../src/lib/replica/entities";

let pg: PGlite;
type Head = { epoch: string; revision: number; floor_revision: number };
const owner = "connection-title-migration",
  id = randomUUID(),
  deleted = randomUUID();
beforeAll(async () => {
  pg = new PGlite();
  for (const file of (await readdir("db"))
    .filter((file) => /^\d+.*\.sql$/.test(file) && file < "032_")
    .sort())
    await pg.exec(await readFile(`db/${file}`, "utf8"));
  for (const connectionId of [id, deleted])
    await pg.query(
      "INSERT INTO library_connections(id,owner_id,source_kind,source_id,target_kind,target_id,relation,status,reason) VALUES($1,$2,'note',$3,'note',$4,'related','accepted','원래 이유')",
      [connectionId, owner, randomUUID(), randomUUID()],
    );
  await pg.query("DELETE FROM library_connections WHERE id=$1", [deleted]);
});
afterAll(async () => {
  await pg?.close();
});
it("adds a blank title and appends a changed projection without resetting sync history or tombstones", async () => {
  const before = (
    await pg.query<Head>("SELECT * FROM library_sync_heads WHERE owner_id=$1", [
      owner,
    ])
  ).rows[0];
  const oldEvents = (
    await pg.query(
      "SELECT * FROM library_sync_changes WHERE owner_id=$1 ORDER BY revision",
      [owner],
    )
  ).rows;
  const oldHash = (
    await pg.query<{ value_sha256: string }>(
      "SELECT value_sha256 FROM library_sync_row_versions WHERE owner_id=$1 AND record_key=$2",
      [owner, JSON.stringify([id])],
    )
  ).rows[0].value_sha256;
  const migration = await readFile("db/032_connection_titles.sql", "utf8");
  await pg.exec(migration);
  const after = (
    await pg.query<Head>("SELECT * FROM library_sync_heads WHERE owner_id=$1", [
      owner,
    ])
  ).rows[0];
  expect(after.epoch).toBe(before.epoch);
  expect(after.floor_revision).toBe(before.floor_revision);
  expect(Number(after.revision)).toBe(Number(before.revision) + 1);
  const events = (
    await pg.query(
      "SELECT * FROM library_sync_changes WHERE owner_id=$1 ORDER BY revision",
      [owner],
    )
  ).rows;
  expect(events.slice(0, oldEvents.length)).toEqual(oldEvents);
  expect(events.at(-1)).toMatchObject({
    entity: "library_connections",
    record_key: JSON.stringify([id]),
    action: "upsert",
  });
  expect(
    (await pg.query("SELECT title FROM library_connections")).rows,
  ).toEqual([{ title: "" }]);
  const versions = (
    await pg.query<{
      record_key: string;
      deleted: boolean;
      value_sha256: string | null;
    }>(
      "SELECT record_key,deleted,value_sha256 FROM library_sync_row_versions WHERE owner_id=$1 ORDER BY record_key",
      [owner],
    )
  ).rows;
  expect(
    versions.find((v) => v.record_key === JSON.stringify([deleted])),
  ).toMatchObject({
    deleted: true,
    value_sha256: null,
  });
  expect(
    versions.find((v) => v.record_key === JSON.stringify([id]))?.value_sha256,
  ).not.toBe(oldHash);
  await pg.exec("SET TIME ZONE 'UTC'");
  expect(
    (
      await pg.query<{ matches: boolean }>(
        'SELECT v.value_sha256=encode(sha256(convert_to(public.library_sync_public_row(to_jsonb(c), \'["id","source_kind","source_id","target_kind","target_id","relation","status","reason","method","version","created_at","title"]\'::jsonb)::text,\'UTF8\')),\'hex\') AS matches FROM library_connections c JOIN library_sync_row_versions v ON v.owner_id=c.owner_id AND v.entity=\'library_connections\' AND v.record_key=public.library_sync_key(to_jsonb(c),\'["id"]\'::jsonb) WHERE c.id=$1',
        [id],
      )
    ).rows[0].matches,
  ).toBe(true);
  await pg.exec(migration);
  expect(
    (
      await pg.query<{ revision: number }>(
        "SELECT revision FROM library_sync_heads WHERE owner_id=$1",
        [owner],
      )
    ).rows[0].revision,
  ).toBe(after.revision);
  await pg.query("UPDATE library_connections SET title=$2 WHERE id=$1", [
    id,
    "공감의 범위",
  ]);
  expect(
    (
      await pg.query<{ revision: number }>(
        "SELECT revision FROM library_sync_heads WHERE owner_id=$1",
        [owner],
      )
    ).rows[0].revision,
  ).toBe(Number(after.revision) + 1);
  await expect(
    pg.query("UPDATE library_connections SET title=$2 WHERE id=$1", [
      id,
      "가".repeat(301),
    ]),
  ).rejects.toThrow();
});
it("accepts old and new safe connection projections without changing old serialized values", () => {
  const old = { id, relation: "related", version: 1 };
  expect(projectSyncRow("library_connections", old)).toEqual(old);
  expect(
    projectSyncRow("library_connections", { ...old, title: "연결 이름" }),
  ).toEqual({
    ...old,
    title: "연결 이름",
  });
});
