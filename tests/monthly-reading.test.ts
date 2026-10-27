import { beforeAll, afterAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { readCyclePage } from "../src/server/record-catalog";
import { createMemoryReplica } from "../src/client/replica/memory-storage";
import { createReplicaRepository } from "../src/client/replica/repository";
import { bootstrapReplica } from "../src/client/replica/bootstrap";
import {
  readSyncMeta,
  readSyncChanges,
  scanSyncRows,
} from "../src/server/sync/read";
import { readSyncCoverage } from "../src/server/sync/coverage";
import { readSyncValuePart } from "../src/server/sync/values";
import type { SyncMeta } from "../src/client/replica/transport";
import type { ReadingCycle } from "../src/lib/domain";
let f: Awaited<ReturnType<typeof testDatabase>>,
  repo: ReturnType<typeof createReplicaRepository>;
const owner = "month-fixture",
  books = [randomUUID(), randomUUID()],
  ids = Array.from(
    { length: 9 },
    (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
  );
const json = (v: unknown) => JSON.parse(JSON.stringify(v));
beforeAll(async () => {
  f = await testDatabase();
  for (const [i, id] of books.entries())
    await f.db.query(
      "INSERT INTO library_books(id,owner_id,title,formats) VALUES($1,$2,$3,ARRAY['paper'])",
      [id, owner, `도서 ${i}`],
    );
  const rows = [
    [ids[0], books[1], "completed", "2026-10-22"],
    [ids[1], books[0], "completed", "2026-10-02"],
    [ids[2], books[0], "completed", "2026-10-10"],
    [ids[3], books[1], "completed", "2026-10-10"],
    [ids[4], books[0], "completed", "2026-09-30"],
    [ids[5], books[0], "completed", "2026-11-01"],
    [ids[6], books[0], "completed", null],
    [ids[7], books[0], "reading", null],
  ];
  for (const [id, book, status, date] of rows)
    await f.db.query(
      "INSERT INTO library_cycles(id,owner_id,book_id,status,completed_on) VALUES($1,$2,$3,$4,$5)",
      [id, owner, book, status, date],
    );
  const foreignBook = randomUUID();
  await f.db.query(
    "INSERT INTO library_books(id,owner_id,title,formats) VALUES($1,'other-month-owner','다른 사람 책',ARRAY['paper'])",
    [foreignBook],
  );
  await f.db.query(
    "INSERT INTO library_cycles(id,owner_id,book_id,status,completed_on) VALUES($1,'other-month-owner',$2,'completed','2026-10-01')",
    [ids[8], foreignBook],
  );
  const storage = createMemoryReplica(owner);
  await bootstrapReplica({
    owner,
    storage,
    transport: {
      meta: async (inventory) =>
        (await readSyncMeta(f.db, owner, inventory)) as SyncMeta,
      scan: (entity, after) => scanSyncRows(f.db, owner, { entity, after }),
      changes: (epoch, cursor) =>
        readSyncChanges(f.db, owner, { epoch, cursor }),
      value: (row, index) =>
        readSyncValuePart(f.db, owner, {
          entity: row.entity,
          key: row.key,
          revision: row.revision,
          index,
        }),
      coverage: () => readSyncCoverage(f.db, owner),
    },
  });
  repo = createReplicaRepository(storage);
});
afterAll(async () => {
  repo?.close();
  await f?.pg.close();
});
it("pages only completed cycles of the selected month in stable ascending order and keeps rereads", async () => {
  const a = await readCyclePage(f.db, owner, {
    completedMonth: "2026-10",
    limit: 2,
  });
  const b = await readCyclePage(f.db, owner, {
    completedMonth: "2026-10",
    limit: 2,
    offset: 2,
  });
  expect(a.total).toBe(4);
  expect([...a.items, ...b.items].map((c) => c.id)).toEqual([
    ids[1],
    ids[2],
    ids[3],
    ids[0],
  ]);
  expect(a.items.map((c) => c.bookId)).toEqual([books[0], books[0]]);
  expect(a.books.map((b) => b.id)).toEqual([books[0]]);
  expect(a.nextOffset).toBe(2);
  expect(b.nextOffset).toBe(null);
  expect(
    (await readCyclePage(f.db, "missing-owner", { completedMonth: "2026-10" }))
      .items,
  ).toEqual([]);
});
it("returns the same month pages and book metadata from the device repository and server", async () => {
  for (const completedMonth of ["2026-09", "2026-10", "2026-11", "2026-12"])
    for (const offset of [0, 2, 9]) {
      const query = { completedMonth, limit: 2, offset };
      expect(json(await repo.reading(query))).toEqual(
        json(await readCyclePage(f.db, owner, query)),
      );
    }
  expect(
    (await repo.reading({ completedMonth: "2026-10" })).items.map(
      (c: ReadingCycle) => c.id,
    ),
  ).toEqual([ids[1], ids[2], ids[3], ids[0]]);
});
it("rejects invalid month filters on both paths", async () => {
  for (const completedMonth of ["2026-13", "2026-1", "invalid"]) {
    await expect(
      readCyclePage(f.db, owner, { completedMonth }),
    ).rejects.toThrow();
    await expect(repo.reading({ completedMonth })).rejects.toThrow();
  }
});
