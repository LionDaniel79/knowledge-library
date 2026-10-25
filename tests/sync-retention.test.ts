import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { pruneSyncChanges } from "../src/server/sync/retention";
import { readSyncMeta, readSyncChanges } from "../src/server/sync/read";
import {
  createSyncCursor,
  parseSyncCursor,
} from "../src/lib/replica/contracts";
let f: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  f = await testDatabase();
});
afterAll(async () => {
  await f?.pg.close();
});
it("removes only a contiguous expired journal prefix and preserves books, revisions, exclusions and tombstones", async () => {
  const owner = randomUUID(),
    id = randomUUID();
  await f.db.query(
    "INSERT INTO library_books(id,owner_id,title,formats) VALUES($1,$2,'원본',ARRAY['paper'])",
    [id, owner],
  );
  await f.db.query(
    "UPDATE library_books SET title='변경' WHERE owner_id=$1 AND id=$2",
    [owner, id],
  );
  await f.db.query(
    "INSERT INTO library_revisions(id,owner_id,entity_id,action,after_data) VALUES($1,$2,$3,'test','{}')",
    [randomUUID(), owner, id],
  );
  await f.db.query(
    "INSERT INTO library_book_exclusions(id,owner_id,kind,reason,batch_id) VALUES($1,$2,'paper','보존',$3)",
    [id, owner, randomUUID()],
  );
  const removed = randomUUID();
  await f.db.query(
    "INSERT INTO library_books(id,owner_id,title,formats) VALUES($1,$2,'삭제된 책',ARRAY['paper'])",
    [removed, owner],
  );
  await f.db.query("DELETE FROM library_books WHERE owner_id=$1 AND id=$2", [
    owner,
    removed,
  ]);
  const before = await readSyncMeta(f.db, owner, false);
  await f.db.query(
    "UPDATE library_sync_changes SET created_at=now()-interval '181 days' WHERE owner_id=$1 AND (revision<=2 OR revision>=5)",
    [owner],
  );
  await pruneSyncChanges(f.db, owner, {});
  const after = await readSyncMeta(f.db, owner, false);
  expect(after.head).toBe(before.head);
  expect(after.floor).toBe("2");
  expect(
    (
      await f.db.query(
        "SELECT count(*)::int AS n FROM library_books WHERE owner_id=$1",
        [owner],
      )
    ).rows[0].n,
  ).toBe(1);
  for (const table of ["library_revisions", "library_book_exclusions"])
    expect(
      (
        await f.db.query(
          `SELECT count(*)::int AS n FROM ${table} WHERE owner_id=$1`,
          [owner],
        )
      ).rows[0].n,
    ).toBe(1);
  await expect(
    readSyncChanges(f.db, owner, {
      epoch: after.epoch,
      cursor: createSyncCursor({ owner, epoch: after.epoch, after: "0" }),
    }),
  ).rejects.toMatchObject({ status: 410 });
  const delta = await readSyncChanges(f.db, owner, {
    epoch: after.epoch,
    cursor: createSyncCursor({ owner, epoch: after.epoch, after: "2" }),
  });
  // Insert+delete of the same book is delivered once as its current tombstone.
  expect(delta.rows).toHaveLength(3);
  expect(delta.rows.map((r) => r.entity).sort()).toEqual([
    "library_book_exclusions",
    "library_books",
    "library_revisions",
  ]);
  expect(delta.rows.find((r) => r.entity === "library_books")).toMatchObject({
    key: JSON.stringify([removed]),
    deleted: true,
  });
  expect(parseSyncCursor(delta.cursor, owner, after.epoch).after).toBe(
    after.head,
  );
  expect(delta.hasMore).toBe(false);
  expect(
    (
      await f.db.query(
        "SELECT deleted FROM library_sync_row_versions WHERE owner_id=$1 AND entity='library_books' AND record_key=$2",
        [owner, JSON.stringify([removed])],
      )
    ).rows[0].deleted,
  ).toBe(true);
});
