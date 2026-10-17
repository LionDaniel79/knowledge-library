import { afterAll, beforeAll, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import {
  readSyncMeta,
  scanSyncRows,
  readSyncChanges,
} from "../src/server/sync/read";
import { readSyncCoverage } from "../src/server/sync/coverage";
import { withSyncWrite } from "../src/server/sync/write";
import { syncEntities, type SyncEntity } from "../src/lib/replica/entities";
import {
  createSyncCursor,
  parseSyncCursor,
  type SyncRow,
} from "../src/lib/replica/contracts";
let f: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  f = await testDatabase();
});
afterAll(async () => {
  await f?.pg.close();
});
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
function coverage(rows: SyncRow[]) {
  return Object.fromEntries(
    Object.keys(syncEntities).map((entity) => {
      const values = rows
        .filter((r) => r.entity === entity && !r.deleted)
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      return [
        entity,
        {
          rows: values.length,
          sha256: hash(
            values.map((r) => r.key + "\t" + r.sha256 + "\n").join(""),
          ),
        },
      ];
    }),
  );
}
function stage(map: Map<string, SyncRow>, rows: SyncRow[]) {
  for (const row of rows) {
    const key = row.entity + "\0" + row.key,
      old = map.get(key);
    if (!old || BigInt(row.revision) >= BigInt(old.revision)) map.set(key, row);
  }
}
it("catches inserts behind the scan, pending deletions, edits, image changes and exclusion/restoration, including legacy revision zero", async () => {
  const owner = randomUUID(),
    asset = randomUUID(),
    batch = randomUUID();
  const ids = [
    "20000000-0000-4000-8000-000000000000",
    "60000000-0000-4000-8000-000000000000",
    "90000000-0000-4000-8000-000000000000",
  ];
  await withSyncWrite(f.db, owner, async (tx) => {
    for (const id of ids)
      await tx.query(
        "INSERT INTO library_books(id,owner_id,title,formats) VALUES($1,$2,'기존 자료',ARRAY['paper'])",
        [id, owner],
      );
    await tx.query(
      "INSERT INTO library_cover_assets(id,owner_id,sha256,data_base64,mime) VALUES($1,$2,$3,'YWJj','image/webp')",
      [asset, owner, hash("abc")],
    );
    await tx.query(
      "INSERT INTO library_book_exclusions(id,owner_id,kind,reason,batch_id) VALUES($1,$2,'paper','처음 제외',$3)",
      [ids[1], owner, batch],
    );
  });
  // Synthetic baseline mirrors data present before tracking was introduced.
  await f.db.query("DELETE FROM library_sync_changes WHERE owner_id=$1", [
    owner,
  ]);
  await f.db.query("DELETE FROM library_sync_row_versions WHERE owner_id=$1", [
    owner,
  ]);
  await f.db.query(
    "UPDATE library_sync_heads SET revision=0 WHERE owner_id=$1",
    [owner],
  );
  const start = await readSyncMeta(f.db, owner),
    replica = new Map<string, SyncRow>();
  expect(start.head).toBe("0");
  stage(
    replica,
    (await scanSyncRows(f.db, owner, { entity: "library_cover_assets" })).rows,
  );
  stage(
    replica,
    (await scanSyncRows(f.db, owner, { entity: "library_book_exclusions" }))
      .rows,
  );
  const first = await scanSyncRows(f.db, owner, {
    entity: "library_books",
    limit: 1,
  });
  stage(replica, first.rows);
  expect(first.rows[0].revision).toBe("0");
  await withSyncWrite(f.db, owner, async (tx) => {
    await tx.query(
      "INSERT INTO library_books(id,owner_id,title,formats) VALUES('10000000-0000-4000-8000-000000000000',$1,'이미 지난 키',ARRAY['paper'])",
      [owner],
    );
    await tx.query("DELETE FROM library_books WHERE owner_id=$1 AND id=$2", [
      owner,
      ids[2],
    ]);
    await tx.query(
      "UPDATE library_books SET title='중간 변경' WHERE owner_id=$1 AND id=$2",
      [owner, ids[0]],
    );
    await tx.query(
      "UPDATE library_books SET title='최신 변경' WHERE owner_id=$1 AND id=$2",
      [owner, ids[0]],
    );
    await tx.query(
      "UPDATE library_cover_assets SET sha256=$3,data_base64='ZGVm' WHERE owner_id=$1 AND id=$2",
      [owner, asset, hash("def")],
    );
    await tx.query(
      "UPDATE library_book_exclusions SET state='restored',version=version+1 WHERE owner_id=$1 AND id=$2",
      [owner, ids[1]],
    );
    await tx.query(
      "INSERT INTO library_book_exclusions(id,owner_id,kind,reason,batch_id) VALUES($1,$2,'paper','다운로드 중 제외',$3)",
      [ids[0], owner, batch],
    );
  });
  let after = first.cursor;
  while (true) {
    const p = await scanSyncRows(f.db, owner, {
      entity: "library_books",
      after,
      limit: 1,
    });
    stage(replica, p.rows);
    after = p.cursor;
    if (!p.hasMore) break;
  }
  for (const entity of Object.keys(syncEntities) as SyncEntity[]) {
    if (
      [
        "library_books",
        "library_cover_assets",
        "library_book_exclusions",
      ].includes(entity)
    )
      continue;
    stage(replica, (await scanSyncRows(f.db, owner, { entity })).rows);
  }
  let cursor = createSyncCursor({
      owner,
      epoch: start.epoch,
      after: start.head,
    }),
    head = start.head;
  for (let i = 0; i < 30; i++) {
    const p = await readSyncChanges(f.db, owner, {
      epoch: start.epoch,
      cursor,
      limit: 1,
    });
    stage(replica, p.rows);
    cursor = p.cursor;
    head = p.head;
    if (!p.hasMore) break;
  }
  const expected = await readSyncCoverage(f.db, owner);
  expect(head).toBe(expected.head);
  expect(coverage([...replica.values()])).toEqual(expected.entities);
  expect(
    JSON.parse(
      replica.get("library_books\0" + JSON.stringify([ids[0]]))!.inline!,
    ).title,
  ).toBe("최신 변경");
  expect(
    replica.get("library_books\0" + JSON.stringify([ids[2]]))?.deleted,
  ).toBe(true);
});
it("advances a changes cursor only through consumed notifications, even when a row already has a newer revision", async () => {
  const owner = randomUUID(),
    id = randomUUID();
  await withSyncWrite(f.db, owner, async (tx) => {
    await tx.query(
      "INSERT INTO library_books(id,owner_id,title,formats) VALUES($1,$2,'이전',ARRAY['paper'])",
      [id, owner],
    );
    await tx.query(
      "UPDATE library_books SET title='이후' WHERE owner_id=$1 AND id=$2",
      [owner, id],
    );
  });
  const meta = await readSyncMeta(f.db, owner, false),
    cursor = createSyncCursor({ owner, epoch: meta.epoch, after: "0" });
  const first = await readSyncChanges(f.db, owner, {
    epoch: meta.epoch,
    cursor,
    limit: 1,
  });
  expect(first.rows[0].revision).toBe("2");
  expect(first.hasMore).toBe(true);
  expect(parseSyncCursor(first.cursor, owner, meta.epoch).after).toBe("1");
  const next = await readSyncChanges(f.db, owner, {
    epoch: meta.epoch,
    cursor: first.cursor,
    limit: 1,
  });
  expect(next.hasMore).toBe(false);
  expect(next.rows[0]).toEqual(first.rows[0]);
});
it("detects changed content with the same row count and unchanged application version", async () => {
  const owner = randomUUID(),
    id = randomUUID();
  await f.db.query(
    "INSERT INTO library_books(id,owner_id,title,formats) VALUES($1,$2,'앞',ARRAY['paper'])",
    [id, owner],
  );
  const before = await readSyncCoverage(f.db, owner);
  await f.db.query(
    "UPDATE library_books SET title='뒤' WHERE owner_id=$1 AND id=$2",
    [owner, id],
  );
  const after = await readSyncCoverage(f.db, owner);
  expect(after.entities.library_books.rows).toBe(
    before.entities.library_books.rows,
  );
  expect(after.entities.library_books.sha256).not.toBe(
    before.entities.library_books.sha256,
  );
});
