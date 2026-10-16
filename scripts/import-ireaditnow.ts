import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { importPackageInput } from "../src/lib/import-package";
import { createImportStore } from "../src/server/import-store";
import { createLibraryStore, type Database } from "../src/server/library-store";
const file = process.argv[2];
if (!file) throw Error("Pass the converted ireaditnow-library.json path.");
const data = importPackageInput.parse(JSON.parse(await readFile(file, "utf8")));
const local = process.argv.includes("--verify-local");
if (local) {
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = new PGlite();
  try {
    for (const name of [
      "001_library.sql",
      "002_ireaditnow.sql",
      "003_reading_history.sql",
    ])
      await pg.exec(await readFile("db/" + name, "utf8"));
    const db: Database = {
      query: (s, p = []) => pg.query(s, p),
      transaction: (fn) =>
        pg.transaction((tx) => fn({ query: (s, p = []) => tx.query(s, p) })),
    };
    const importer = createImportStore(db);
    const summary = await importer.apply("local-verification", data);
    const again = await importer.apply("local-verification", data);
    const snapshot =
      await createLibraryStore(db).snapshot("local-verification");
    if (
      snapshot.books.length !== data.books.length ||
      snapshot.notes.length !== data.notes.length ||
      again.addedBooks ||
      again.addedNotes
    )
      throw Error("Import reconciliation failed");
    console.log(JSON.stringify({ verified: true, summary, reimport: again }));
  } finally {
    await pg.close();
  }
} else {
  if (!process.env.DATABASE_URL_UNPOOLED || !process.env.LIBRARY_OWNER_EMAIL)
    throw Error("Database and owner configuration required.");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL_UNPOOLED,
    max: 1,
  });
  try {
    const owners = (
      await pool.query(
        'SELECT id FROM neon_auth."user" WHERE lower(email)=lower($1) AND "emailVerified"=true',
        [process.env.LIBRARY_OWNER_EMAIL],
      )
    ).rows;
    if (owners.length !== 1)
      throw Error(
        "Google로 서재에 먼저 로그인해 주세요. 확인된 본인 계정에만 자료를 넣습니다.",
      );
    const db: Database = {
      query: (s, p = []) => pool.query(s, p),
      transaction: async (fn) => {
        const c = await pool.connect();
        try {
          await c.query("BEGIN");
          const r = await fn({ query: (s, p = []) => c.query(s, p) });
          await c.query("COMMIT");
          return r;
        } catch (e) {
          await c.query("ROLLBACK");
          throw e;
        } finally {
          c.release();
        }
      },
    };
    const importer = createImportStore(db);
    const result = process.argv.includes("--apply")
      ? await importer.apply(owners[0].id, data)
      : await importer.preview(owners[0].id, data);
    console.log(JSON.stringify(result));
  } finally {
    await pool.end();
  }
}
