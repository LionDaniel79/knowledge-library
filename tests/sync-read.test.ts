import { afterAll, beforeAll, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import {
  readSyncMeta,
  scanSyncRows,
  readSyncChanges,
} from "../src/server/sync/read";
import { readSyncValuePart } from "../src/server/sync/values";
import {
  syncPage,
  MAX_JSON_RESPONSE_BYTES,
  VALUE_PART_BYTES,
  createSyncCursor,
} from "../src/lib/replica/contracts";
import { syncEntities } from "../src/lib/replica/entities";
let f: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  f = await testDatabase();
});
afterAll(async () => {
  await f?.pg.close();
});
const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
async function book(owner: string, source: unknown = {}) {
  const id = randomUUID();
  await f.db.query(
    "INSERT INTO library_books(id,owner_id,title,formats,source_data) VALUES($1,$2,'제목',ARRAY['paper'],$3)",
    [id, owner, JSON.stringify(source)],
  );
  return id;
}
it("reads all public entities without changing the database and isolates cursor ownership", async () => {
  const owner = randomUUID(),
    id = await book(owner),
    other = randomUUID();
  await book(other);
  const before = (
    await f.db.query(
      "SELECT revision::text FROM library_sync_heads WHERE owner_id=$1",
      [owner],
    )
  ).rows[0];
  const meta = await readSyncMeta(f.db, owner);
  expect(Object.keys(meta.entities).sort()).toEqual(
    Object.keys(syncEntities).sort(),
  );
  expect(meta.totalRows).toBe(1);
  expect(meta.totalBytes).toBeGreaterThan(0);
  const page = await scanSyncRows(f.db, owner, {
    entity: "library_books",
    limit: 15,
  });
  syncPage.parse(page);
  expect(page.rows).toHaveLength(1);
  expect(page.rows[0].key).toBe(JSON.stringify([id]));
  expect(page.rows[0].inline).not.toContain("owner_id");
  await expect(
    scanSyncRows(f.db, other, { entity: "library_books", after: page.cursor }),
  ).rejects.toMatchObject({ status: 400 });
  const start = createSyncCursor({ owner, epoch: meta.epoch, after: "0" });
  const delta = await readSyncChanges(f.db, owner, {
    epoch: meta.epoch,
    cursor: start,
    limit: 10,
  });
  expect(delta.rows[0]).toEqual(page.rows[0]);
  expect(
    (
      await f.db.query(
        "SELECT revision::text FROM library_sync_heads WHERE owner_id=$1",
        [owner],
      )
    ).rows[0],
  ).toEqual(before);
  await expect(
    scanSyncRows(f.db, owner, { entity: "library_mcp_tokens" as any }),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    readSyncValuePart(f.db, owner, {
      entity: "library_books",
      key: '["bad"]',
      revision: "0",
      index: -1,
    }),
  ).rejects.toMatchObject({ status: 400 });
});
it("keeps escaped JSON pages bounded and paginates without losing a record", async () => {
  const owner = randomUUID();
  for (let i = 0; i < 45; i++)
    await book(owner, { text: '"\\\n'.repeat(8000) });
  let after: string | undefined;
  const found = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const page = await scanSyncRows(f.db, owner, {
      entity: "library_books",
      after,
      limit: 200,
    });
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
      MAX_JSON_RESPONSE_BYTES,
    );
    expect(page.rows.length).toBeGreaterThan(0);
    page.rows.forEach((r) => found.add(r.key));
    after = page.cursor;
    if (!page.hasMore) break;
  }
  expect(found.size).toBe(45);
});
it("assembles a four MiB original JSON and every image byte with SQL-sized value reads, then rejects a changed revision", async () => {
  const owner = randomUUID(),
    id = await book(owner, { original: "한글🙂".repeat(430000) });
  const asset = randomUUID(),
    image = "YWJj".repeat(90000);
  await f.db.query(
    "INSERT INTO library_cover_assets(id,owner_id,sha256,data_base64,mime) VALUES($1,$2,$3,$4,'image/webp')",
    [asset, owner, hash(Buffer.from(image, "base64")), image],
  );
  const { rows } = await scanSyncRows(f.db, owner, { entity: "library_books" });
  const cover = (
    await scanSyncRows(f.db, owner, { entity: "library_cover_assets" })
  ).rows[0];
  for (const row of [rows[0], cover]) {
    expect(row.inline).toBeUndefined();
    expect(row.parts!.length).toBeGreaterThan(1);
    const parts: Uint8Array[] = [];
    for (const part of row.parts!) {
      const bytes = await readSyncValuePart(f.db, owner, {
        entity: row.entity,
        key: row.key,
        revision: row.revision,
        index: part.index,
      });
      expect(bytes.byteLength).toBeLessThanOrEqual(VALUE_PART_BYTES);
      expect(hash(bytes)).toBe(part.sha256);
      parts.push(bytes);
    }
    const value = Buffer.concat(parts);
    expect(value.length).toBe(row.bytes);
    expect(hash(value)).toBe(row.sha256);
    const decoded = JSON.parse(value.toString("utf8"));
    if (row === cover) expect(decoded.data_base64).toBe(image);
    else expect(decoded.source_data.original.length).toBe(430000 * 4);
  }
  await expect(
    readSyncValuePart(f.db, "someone-else", {
      entity: cover.entity,
      key: cover.key,
      revision: cover.revision,
      index: 0,
    }),
  ).rejects.toMatchObject({ status: 404 });
  await f.db.query(
    "UPDATE library_books SET title='바뀜' WHERE owner_id=$1 AND id=$2",
    [owner, id],
  );
  await expect(
    readSyncValuePart(f.db, owner, {
      entity: rows[0].entity,
      key: rows[0].key,
      revision: rows[0].revision,
      index: 0,
    }),
  ).rejects.toMatchObject({ status: 409 });
});
it("works with read-only table privileges without access to private sync helper functions", async () => {
  const owner = randomUUID();
  await book(owner);
  await f.pg.exec(
    "CREATE ROLE sync_test_reader; GRANT USAGE ON SCHEMA public TO sync_test_reader; GRANT SELECT ON ALL TABLES IN SCHEMA public TO sync_test_reader; GRANT EXECUTE ON FUNCTION public.library_sync_redact(jsonb) TO sync_test_reader; SET ROLE sync_test_reader",
  );
  try {
    expect((await readSyncMeta(f.db, owner)).totalRows).toBe(1);
    expect(
      (await scanSyncRows(f.db, owner, { entity: "library_books" })).rows,
    ).toHaveLength(1);
    await expect(
      f.db.query("SELECT public.library_sync_emit($1,$2,$3,$4::jsonb)", [
        owner,
        "library_books",
        "[]",
        "{}",
      ]),
    ).rejects.toThrow();
  } finally {
    await f.pg.exec("RESET ROLE");
  }
});
