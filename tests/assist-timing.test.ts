import { expect, it } from "vitest";
import { measureAssistDatabase } from "../src/server/assist-timing";
it("reports only aggregate transaction/query timings and preserves results", async () => {
  const db: any = {
    query: async () => ({ rows: [{ ok: true }] }),
    transaction: async (fn: any) => fn(db),
  };
  const m = measureAssistDatabase(db);
  expect(await m.db.transaction((tx) => tx.query("private sql"))).toEqual({
    rows: [{ ok: true }],
  });
  expect(m.header()).toMatch(
    /db_tx;dur=[\d.]+, db_sql;dur=[\d.]+, db_queries;desc="1"/,
  );
  expect(m.header()).not.toContain("private");
});
