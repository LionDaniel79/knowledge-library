import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import {
  importPdfCatalog,
  type PdfCatalogDocument,
} from "../src/server/pdf-catalog-import";
import type { Database } from "../src/server/library-store";
const path = process.env.LIBRARY_PDF_INDEX;
if (!path) throw Error("LIBRARY_PDF_INDEX required");
const local = new DatabaseSync(path, { readOnly: true });
const files = local
  .prepare(
    "SELECT * FROM documents WHERE status<>'missing' ORDER BY relative_path",
  )
  .all();
local.close();
if (files.some((d) => !d.scope_version))
  throw Error("PDF 범위 분류(scope)를 먼저 실행해 주세요.");
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
  if (owners.length !== 1) throw Error("Verified owner required");
  const owner = owners[0].id;
  if (!process.argv.includes("--apply")) {
    console.log(JSON.stringify({ files: files.length, apply: false }));
  } else {
    const db: Database = {
      query: (sql, args = []) => pool.query(sql, args),
      transaction: async (fn) => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const value = await fn({
            query: (sql, args = []) => client.query(sql, args),
          });
          await client.query("COMMIT");
          return value;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      },
    };
    const result = await importPdfCatalog(
      db,
      owner,
      files as unknown as PdfCatalogDocument[],
      (processed, addedBooks) => {
        if (processed % 1000 === 250)
          console.log(JSON.stringify({ processed, addedBooks }));
      },
    );
    console.log(JSON.stringify(result));
  }
} finally {
  await pool.end();
}
