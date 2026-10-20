import { expect, it } from "vitest";
import { testDatabase } from "./helpers/database";
import { readSyncChanges, readSyncMeta } from "../src/server/sync/read";
import {
  createSyncCursor,
  parseSyncCursor,
} from "../src/lib/replica/contracts";
it("orders changes numerically across 99/100/999/1000 and never skips a memo change", async () => {
  const f = await testDatabase(),
    owner = "numeric-order",
    id = crypto.randomUUID();
  try {
    await f.db.query(
      "INSERT INTO library_books(id,owner_id,title,formats) VALUES($1,$2,'Book',ARRAY['paper'])",
      [id, owner],
    );
    const key = JSON.stringify([id]);
    await f.db.query(
      "UPDATE library_sync_heads SET revision=1000 WHERE owner_id=$1",
      [owner],
    );
    await f.db.query(
      "INSERT INTO library_sync_changes(owner_id,revision,entity,record_key,action) SELECT $1,n,'library_books',$2,'upsert' FROM unnest(ARRAY[99,100,101,999,1000]) n",
      [owner, key],
    );
    const meta = await readSyncMeta(f.db, owner, false);
    const page = await readSyncChanges(f.db, owner, {
      epoch: meta.epoch,
      cursor: createSyncCursor({ owner, epoch: meta.epoch, after: "99" }),
      limit: 2,
    });
    expect(parseSyncCursor(page.cursor, owner, meta.epoch).after).toBe("101");
  } finally {
    await f.pg.close();
  }
});
