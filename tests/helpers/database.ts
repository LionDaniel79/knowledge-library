import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import type { Database } from "../../src/server/library-store";
export async function testDatabase() {
  const pg = new PGlite();
  for (const f of (await readdir("db"))
    .filter((f) => /^\d+.*\.sql$/.test(f))
    .sort())
    await pg.exec(await readFile(`db/${f}`, "utf8"));
  const db: Database = {
    query: (s, p = []) => pg.query(s, p),
    transaction: (fn) =>
      pg.transaction((tx) => fn({ query: (s, p = []) => tx.query(s, p) })),
  };
  return { pg, db };
}
