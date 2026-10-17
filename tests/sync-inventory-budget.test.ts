import { expect, it } from "vitest";
import { testDatabase } from "./helpers/database";
import { readSyncMeta } from "../src/server/sync/read";
import { readSyncCoverage } from "../src/server/sync/coverage";
import { syncEntities } from "../src/lib/replica/entities";
import type { Database } from "../src/server/library-store";
it("collects exact complete inventory and coverage under a bounded per-statement table budget", async () => {
  const f = await testDatabase(),
    owner = "bounded-inventory",
    id = crypto.randomUUID();
  try {
    await f.db.query(
      "INSERT INTO library_books(owner_id,id,title,formats) VALUES($1,$2,'Book',ARRAY['paper'])",
      [owner, id],
    );
    const expectedMeta = await readSyncMeta(f.db, owner),
      expectedCoverage = await readSyncCoverage(f.db, owner);
    // The runtime has a per-statement deadline. A history/image inventory must
    // not combine the expensive full projections of all tables in one statement.
    const limited: Database = {
      query: f.db.query,
      transaction: (fn) =>
        f.db.transaction((tx) =>
          fn({
            query: async (sql, params = []) => {
              const tables = Object.keys(syncEntities).filter((entity) =>
                sql.includes('"' + entity + '"'),
              );
              if (tables.length > 1)
                throw Object.assign(Error("statement budget"), {
                  code: "57014",
                });
              return tx.query(sql, params);
            },
          }),
        ),
    };
    expect(await readSyncMeta(limited, owner)).toEqual(expectedMeta);
    expect(await readSyncCoverage(limited, owner)).toEqual(expectedCoverage);
  } finally {
    await f.pg.close();
  }
});
