import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { createLibraryStore, type Database } from "../src/server/library-store";
import { createCurationStore } from "../src/server/curation-store";
import { importPdfCatalog } from "../src/server/pdf-catalog-import";
import { syncQuery } from "../src/server/sync/write";
let f: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  f = await testDatabase();
});
afterAll(async () => {
  await f?.pg.close();
});
function observed() {
  const calls: string[] = [];
  const query =
    (target: any) =>
    (sql: string, args: unknown[] = []) => {
      calls.push(sql);
      return target.query(sql, args);
    };
  const db: Database = {
    query: query(f.db),
    transaction: (fn) => f.db.transaction((tx) => fn({ query: query(tx) })),
  };
  return { db, calls };
}
function expectLockBeforeWrite(calls: string[]) {
  const write = calls.findIndex((s) =>
    /INSERT INTO|UPDATE library_|DELETE FROM|FOR UPDATE|LOCK TABLE/i.test(s),
  );
  const lock = calls.findIndex((s) => s.includes("library_sync_lock"));
  expect(write).toBeGreaterThanOrEqual(0);
  expect(lock).toBeGreaterThanOrEqual(0);
  expect(lock).toBeLessThan(write);
}
it("takes the owner boundary before normal commands, PDF reimports and collection writes", async () => {
  const owner = randomUUID();
  for (const action of [
    (db: Database) =>
      createLibraryStore(db).mutate(owner, {
        requestId: randomUUID(),
        type: "addNote",
        payload: { title: "생각", content: "내 글", bookId: null },
      }),
    (db: Database) => createCurationStore(db).begin(owner, "hash", "test"),
    (db: Database) =>
      importPdfCatalog(db, owner, [
        {
          id: randomUUID(),
          root: "E:/전자도서관",
          path: "E:/전자도서관/test.pdf",
          relative_path: "test.pdf",
          title: "책",
          author: "",
          page_count: 10,
          bytes: 100,
          mtime_ns: "123",
          processing_scope: "full",
          material_kind: "book",
          scope_reason: "test",
          scope_version: "test",
        },
      ]),
  ]) {
    const { db, calls } = observed();
    await action(db);
    expectLockBeforeWrite(calls);
  }
  const names = (
    await f.db.query(
      "SELECT DISTINCT entity FROM library_sync_changes WHERE owner_id=$1",
      [owner],
    )
  ).rows.map((r) => r.entity);
  expect(names).toContain("library_notes");
  expect(names).toContain("library_revisions");
  expect(names).toContain("library_documents");
  expect(names).toContain("library_curation_runs");
});
it("does not take a write lock for normal catalog reads and keeps all preview reads side effect free", async () => {
  const { db, calls } = observed();
  await createLibraryStore(db).overview("reader");
  expect(calls.some((s) => s.includes("library_sync_lock"))).toBe(false);
});
it("supports guarded direct collector statements and rejects a bare autocommit executor", async () => {
  const owner = randomUUID(),
    { db, calls } = observed();
  await syncQuery(
    db,
    owner,
    "INSERT INTO library_curation_runs(id,owner_id,scope_hash,executor) VALUES($1,$2,'test','test')",
    [randomUUID(), owner],
  );
  expectLockBeforeWrite(calls);
  await expect(
    syncQuery(
      { query: f.db.query },
      owner,
      "INSERT INTO library_curation_runs(id,owner_id,scope_hash,executor) VALUES($1,$2,'test','test')",
      [randomUUID(), owner],
    ),
  ).rejects.toThrow();
  expect(
    (
      await f.db.query(
        "SELECT id FROM library_curation_runs WHERE owner_id=$1",
        [owner],
      )
    ).rows,
  ).toHaveLength(1);
});
