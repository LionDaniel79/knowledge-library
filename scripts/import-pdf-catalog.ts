import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { createHash, randomUUID } from "node:crypto";
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
    let added = 0;
    const c = await pool.connect();
    try {
      for (let offset = 0; offset < files.length; offset += 250) {
        await c.query("BEGIN");
        const rows = files.slice(offset, offset + 250).map((d) => {
          const h = createHash("sha256")
            .update(owner + ":pdf:" + d.id)
            .digest("hex");
          return {
            ...d,
            bookId: `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`,
            sourceKey: JSON.stringify(["Local PDF", d.root, d.id]),
            tags: String(d.relative_path)
              .split(/[\\/]/)
              .slice(0, -1)
              .filter((x) => x.length <= 40)
              .slice(-5),
            sourceData: {
              app: "Local PDF",
              libraryId: String(d.root),
              recordId: String(d.id),
              raw: {
                relativePath: d.relative_path,
                metadataStatus: "unverified",
              },
            },
            revisionId: randomUUID(),
          };
        });
        const result = await c.query(
          `WITH added AS (INSERT INTO library_books(id,owner_id,title,author,formats,total_pages,shelf,tags,source_key,source_data)
      SELECT r."bookId",$1,left(r.title,300),left(r.author,300),ARRAY['pdf'],r.page_count,r.relative_path,r.tags,r."sourceKey",r."sourceData"
      FROM jsonb_to_recordset($2::jsonb) AS r("bookId" uuid,title text,author text,page_count integer,relative_path text,tags text[],"sourceKey" text,"sourceData" jsonb)
      ON CONFLICT(owner_id,source_key) DO NOTHING RETURNING *)
      INSERT INTO library_revisions(id,owner_id,entity_id,action,after_data)
      SELECT r."revisionId",$1,a.id,'importPdf',to_jsonb(a) FROM added a JOIN jsonb_to_recordset($2::jsonb) AS r("bookId" uuid,"revisionId" uuid) ON r."bookId"=a.id RETURNING entity_id`,
          [owner, JSON.stringify(rows)],
        );
        added += result.rowCount ?? 0;
        await c.query(
          `INSERT INTO library_documents(id,owner_id,book_id,root,path,relative_path,bytes,mtime_ns,processing_scope,material_kind,scope_reason,scope_version)
      SELECT r.id,$1,r."bookId",r.root,r.path,r.relative_path,r.bytes,r.mtime_ns,r.processing_scope,r.material_kind,r.scope_reason,r.scope_version FROM jsonb_to_recordset($2::jsonb) AS r(id uuid,"bookId" uuid,root text,path text,relative_path text,bytes bigint,mtime_ns text,processing_scope text,material_kind text,scope_reason text,scope_version text)
      ON CONFLICT(owner_id,id) DO UPDATE SET bytes=excluded.bytes,mtime_ns=excluded.mtime_ns,processing_scope=excluded.processing_scope,material_kind=excluded.material_kind,scope_reason=excluded.scope_reason,scope_version=excluded.scope_version`,
          [owner, JSON.stringify(rows)],
        );
        await c.query("COMMIT");
        if (offset % 1000 === 0)
          console.log(
            JSON.stringify({
              processed: Math.min(offset + 250, files.length),
              addedBooks: added,
            }),
          );
      }
      console.log(JSON.stringify({ files: files.length, addedBooks: added }));
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
} finally {
  await pool.end();
}
