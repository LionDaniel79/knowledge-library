import { afterAll, beforeAll, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import type { Database, Executor } from "../src/server/library-store";
import { readSyncChanges, readSyncMeta } from "../src/server/sync/read";
import { readSyncValuePart } from "../src/server/sync/values";
import {
  createSyncCursor,
  parseSyncCursor,
  MAX_JSON_RESPONSE_BYTES,
} from "../src/lib/replica/contracts";
import { sqlSyncTransport } from "./helpers/sync-transport";
import { createMemoryReplica } from "../src/client/replica/memory-storage";
import { bootstrapReplica } from "../src/client/replica/bootstrap";
import { pullReplica } from "../src/client/replica/pull";

let f: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  f = await testDatabase();
});
afterAll(async () => {
  await f?.pg.close();
});
const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const hash = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
function meter(database: Database) {
  const reads: { bytes: number; sql: string }[] = [];
  const wrap = (tx: Executor): Executor => ({
    async query(sql, params) {
      const result = await tx.query(sql, params);
      reads.push({ sql, bytes: jsonBytes(result.rows) });
      return result;
    },
  });
  const db: Database = {
    query: wrap(database).query,
    transaction: (fn) => database.transaction((tx) => fn(wrap(tx))),
  };
  return {
    db,
    reads,
    reset: () => {
      reads.length = 0;
    },
  };
}
async function insertBook(owner: string, text = "short") {
  const id = randomUUID();
  await f.db.query(
    "INSERT INTO library_books(owner_id,id,title,formats,source_data) VALUES($1,$2,'Book',ARRAY['paper'],$3::jsonb)",
    [owner, id, JSON.stringify({ text })],
  );
  return id;
}
async function start(owner: string) {
  const meta = await readSyncMeta(f.db, owner, false);
  return {
    epoch: meta.epoch,
    cursor: createSyncCursor({ owner, epoch: meta.epoch, after: "0" }),
    limit: 200,
  };
}
it("bounds actual DB results before returning a change page instead of discarding megabytes in the app", async () => {
  const owner = randomUUID();
  await f.db.query(
    `INSERT INTO library_books(owner_id,id,title,formats,source_data)
     SELECT $1,md5($1||i::text)::uuid,'Book '||i,ARRAY['paper'],jsonb_build_object('text',repeat('x',48000)) FROM generate_series(1,200) i`,
    [owner],
  );
  const input = await start(owner),
    measured = meter(f.db);
  const page = await readSyncChanges(measured.db, owner, input);
  expect(page.rows.length).toBeGreaterThan(0);
  expect(page.hasMore).toBe(true);
  expect(jsonBytes(page)).toBeLessThanOrEqual(MAX_JSON_RESPONSE_BYTES);
  expect(Math.max(...measured.reads.map((r) => r.bytes))).toBeLessThanOrEqual(
    MAX_JSON_RESPONSE_BYTES,
  );
  expect(measured.reads.reduce((n, r) => n + r.bytes, 0)).toBeLessThanOrEqual(
    MAX_JSON_RESPONSE_BYTES + 65536,
  );
});
it("delivers all 200 large records once while the cursor advances only past consumed events", async () => {
  const owner = randomUUID();
  await f.db.query(
    `INSERT INTO library_books(owner_id,id,title,formats,source_data)
     SELECT $1,md5($1||i::text)::uuid,'Book '||i,ARRAY['paper'],jsonb_build_object('text',repeat('x',48000)) FROM generate_series(1,200) i`,
    [owner],
  );
  const input = await start(owner),
    measured = meter(f.db),
    found = new Set<string>();
  let cursor = input.cursor,
    sent = 0,
    pages = 0;
  do {
    const page = await readSyncChanges(measured.db, owner, {
      ...input,
      cursor,
    });
    expect(
      BigInt(parseSyncCursor(page.cursor, owner, input.epoch).after),
    ).toBeGreaterThan(
      BigInt(parseSyncCursor(cursor, owner, input.epoch).after),
    );
    for (const row of page.rows) {
      expect(found.has(row.key)).toBe(false);
      found.add(row.key);
      sent += row.bytes;
    }
    cursor = page.cursor;
    expect(jsonBytes(page)).toBeLessThanOrEqual(MAX_JSON_RESPONSE_BYTES);
    expect(++pages).toBeLessThan(100);
    if (!page.hasMore) break;
  } while (true);
  expect(found.size).toBe(200);
  const dbBytes = measured.reads.reduce((n, r) => n + r.bytes, 0);
  expect(dbBytes).toBeLessThan(sent * 1.2);
  console.info(
    JSON.stringify({
      fixture: "200-books",
      pages,
      records: found.size,
      valueBytes: sent,
      dbJsonBytes: dbBytes,
    }),
  );
}, 30000);
it("coalesces A/B/A before the next oversized C without advancing across C", async () => {
  const owner = randomUUID(),
    text = '"'.repeat(58000);
  const a = await insertBook(owner, text),
    b = await insertBook(owner, text);
  await f.db.query(
    "UPDATE library_books SET title='updated A' WHERE owner_id=$1 AND id=$2",
    [owner, a],
  );
  const beforeC = await readSyncMeta(f.db, owner, false);
  const c = await insertBook(owner, text);
  await f.db.query(
    "UPDATE library_books SET title='updated B' WHERE owner_id=$1 AND id=$2",
    [owner, b],
  );
  const input = await start(owner),
    measured = meter(f.db);
  const first = await readSyncChanges(measured.db, owner, input);
  expect(new Set(first.rows.map((r) => r.key))).toEqual(
    new Set([JSON.stringify([a]), JSON.stringify([b])]),
  );
  expect(first.rows).toHaveLength(2);
  expect(parseSyncCursor(first.cursor, owner, input.epoch).after).toBe(
    beforeC.head,
  );
  const second = await readSyncChanges(measured.db, owner, {
    ...input,
    cursor: first.cursor,
  });
  expect(second.rows.some((r) => r.key === JSON.stringify([c]))).toBe(true);
  expect(second.hasMore).toBe(false);
  expect(Math.max(...measured.reads.map((r) => r.bytes))).toBeLessThanOrEqual(
    MAX_JSON_RESPONSE_BYTES,
  );
});
it("coalesces mixed-table edits and tombstones, preserving restoration and isolation", async () => {
  const owner = randomUUID(),
    book = await insertBook(owner),
    note = randomUUID(),
    shelf = randomUUID();
  await f.db.query(
    "INSERT INTO library_notes(id,owner_id,title,content,kind) VALUES($1,$2,'memo','one','thought')",
    [note, owner],
  );
  await f.db.query(
    "INSERT INTO library_shelves(id,owner_id,name) VALUES($1,$2,'shelf')",
    [shelf, owner],
  );
  await f.db.query(
    "UPDATE library_notes SET content='two' WHERE owner_id=$1 AND id=$2",
    [owner, note],
  );
  await f.db.query("DELETE FROM library_notes WHERE owner_id=$1 AND id=$2", [
    owner,
    note,
  ]);
  await f.db.query(
    "INSERT INTO library_notes(id,owner_id,title,content,kind) VALUES($1,$2,'restored','three','thought')",
    [note, owner],
  );
  await f.db.query("DELETE FROM library_shelves WHERE owner_id=$1 AND id=$2", [
    owner,
    shelf,
  ]);
  await insertBook("other-owner", "must not be transferred");
  const page = await readSyncChanges(f.db, owner, await start(owner));
  expect(page.rows).toHaveLength(3);
  expect(new Set(page.rows.map((r) => r.entity + ":" + r.key)).size).toBe(3);
  expect(page.rows.find((r) => r.entity === "library_shelves")?.deleted).toBe(
    true,
  );
  expect(
    JSON.parse(page.rows.find((r) => r.entity === "library_notes")!.inline!)
      .content,
  ).toBe("three");
  expect(page.rows.find((r) => r.entity === "library_books")?.key).toBe(
    JSON.stringify([book]),
  );
  expect(page.hasMore).toBe(false);
});
it("keeps large-value part hashes and performs no value fetch on an unchanged cursor", async () => {
  const owner = randomUUID();
  await insertBook(owner, "한글🙂".repeat(60000));
  const input = await start(owner),
    measured = meter(f.db);
  const page = await readSyncChanges(measured.db, owner, input),
    row = page.rows[0];
  expect(row.inline).toBeUndefined();
  const parts = [];
  for (const part of row.parts!) {
    const bytes = await readSyncValuePart(f.db, owner, {
      entity: row.entity,
      key: row.key,
      revision: row.revision,
      index: part.index,
    });
    expect(hash(bytes)).toBe(part.sha256);
    parts.push(bytes);
  }
  expect(hash(Buffer.concat(parts))).toBe(row.sha256);
  measured.reset();
  const unchanged = await readSyncChanges(measured.db, owner, {
    ...input,
    cursor: page.cursor,
  });
  expect(unchanged.rows).toEqual([]);
  expect(unchanged.hasMore).toBe(false);
  expect(measured.reads.every((r) => !r.sql.includes('"library_books"'))).toBe(
    true,
  );
  expect(measured.reads.reduce((n, r) => n + r.bytes, 0)).toBeLessThan(2048);
});
it("rejects a missing current value without falsely completing its event cursor", async () => {
  const owner = randomUUID(),
    id = await insertBook(owner);
  await f.db.query("DELETE FROM library_books WHERE owner_id=$1 AND id=$2", [
    owner,
    id,
  ]);
  await f.db.query("DELETE FROM library_sync_row_versions WHERE owner_id=$1", [
    owner,
  ]);
  await expect(
    readSyncChanges(f.db, owner, await start(owner)),
  ).rejects.toMatchObject({ status: 409 });
});
it("reuses a complete device on no change and resumes a lost memo response without touching its outbox", async () => {
  const owner = randomUUID(),
    measured = meter(f.db),
    storage = createMemoryReplica(owner);
  await insertBook(owner);
  const transport = sqlSyncTransport(measured.db, owner);
  const initial = await bootstrapReplica({ owner, storage, transport });
  const requestId = randomUUID();
  await storage.putOutbox({
    owner,
    requestId,
    entityId: randomUUID(),
    baseVersion: null,
    baseRevision: null,
    family: "library",
    command: {
      type: "addNote",
      payload: { content: "Unsent personal thought" },
    },
    order: 1,
    dependsOn: [],
    state: "pending",
  });
  measured.reset();
  await pullReplica({ owner, storage, transport });
  const unchangedBytes = measured.reads.reduce((n, r) => n + r.bytes, 0);
  expect(unchangedBytes).toBeLessThan(2048);
  const note = randomUUID();
  await f.db.query(
    "INSERT INTO library_notes(id,owner_id,title,content,kind) VALUES($1,$2,'memo','one','thought')",
    [note, owner],
  );
  await f.db.query(
    "UPDATE library_notes SET content='two' WHERE owner_id=$1 AND id=$2",
    [owner, note],
  );
  await f.db.query(
    "UPDATE library_notes SET content='three' WHERE owner_id=$1 AND id=$2",
    [owner, note],
  );
  const base = transport.changes;
  let lost = true;
  transport.changes = async (...args) => {
    const response = await base(...args);
    if (lost) {
      lost = false;
      throw Error("simulated lost response");
    }
    return response;
  };
  await expect(pullReplica({ owner, storage, transport })).rejects.toThrow(
    "lost response",
  );
  expect((await storage.checkpoint())!.cursor).toBe(initial.cursor);
  measured.reset();
  const complete = await pullReplica({ owner, storage, transport });
  const changedBytes = measured.reads.reduce((n, r) => n + r.bytes, 0);
  expect(changedBytes).toBeLessThan(8192);
  expect(complete.generation).toBe(initial.generation);
  const saved = await storage.readRow("library_notes", JSON.stringify([note]));
  expect(JSON.parse(saved!.inline!).content).toBe("three");
  expect((await storage.listOutbox())[0].requestId).toBe(requestId);
  expect((await storage.listOutbox())[0].state).toBe("pending");
  console.info(
    JSON.stringify({
      fixture: "device-delta",
      unchangedDbJsonBytes: unchangedBytes,
      memoDbJsonBytes: changedBytes,
      outboxPreserved: true,
    }),
  );
});
