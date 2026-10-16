import { Pool } from "pg";
import { DatabaseSync } from "node:sqlite";
const pool = new Pool({
  connectionString: process.env.DATABASE_URL_UNPOOLED,
  max: 1,
});
try {
  const owner = (
    await pool.query(
      'SELECT id::text FROM neon_auth."user" WHERE lower(email)=lower($1)',
      [process.env.LIBRARY_OWNER_EMAIL],
    )
  ).rows[0]?.id;
  if (!owner) throw Error("Owner unavailable");
  console.log(
    JSON.stringify(
      {
        groups: (
          await pool.query(
            "SELECT source_data->>'app' AS source,count(*)::int AS count,count(nullif(isbn,''))::int AS isbn,count(nullif(author,''))::int AS author FROM library_books WHERE owner_id=$1 GROUP BY 1",
            [owner],
          )
        ).rows,
        tags: (
          await pool.query(
            "SELECT tag,count(*)::int AS count FROM library_books,unnest(tags) tag WHERE owner_id=$1 GROUP BY tag ORDER BY count(*) DESC LIMIT 45",
            [owner],
          )
        ).rows,
        sample: (
          await pool.query(
            "SELECT title,author,isbn,tags FROM library_books WHERE owner_id=$1 AND source_data->>'app'='Local PDF' ORDER BY created_at,id LIMIT 15",
            [owner],
          )
        ).rows,
        configured: {
          nationalLibrary: !!process.env.DATA4LIBRARY_KEY,
          aladin: !!process.env.ALADIN_TTB_KEY,
          googleBooks: !!process.env.GOOGLE_BOOKS_API_KEY,
        },
      },
      null,
      2,
    ),
  );
  const local = new DatabaseSync(process.env.LIBRARY_PDF_INDEX!, {
    readOnly: true,
  });
  console.log(
    JSON.stringify({
      pdfStatus: local
        .prepare(
          "SELECT status,count(*) AS count FROM documents GROUP BY status",
        )
        .all(),
      columns: local
        .prepare("PRAGMA table_info(documents)")
        .all()
        .map((r: any) => r.name),
    }),
  );
  local.close();
} finally {
  await pool.end();
}
