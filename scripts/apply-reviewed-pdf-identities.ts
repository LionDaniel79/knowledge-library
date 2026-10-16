/** Apply a reviewed frozen sample without touching the running discovery job or its cache. */
import { Pool } from "pg";
import { DatabaseSync } from "node:sqlite";
import { readFile, writeFile } from "node:fs/promises";
import { realpathSync, statSync } from "node:fs";
import { relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import {
  extractPdfIdentity,
  type IdentityPage,
} from "../src/local/curation/pdf-identity";
import { applyPdfIdentity } from "../src/local/curation/pdf-identity-store";
import {
  verifiedCurationOwner,
  reviewedIdentityBook,
} from "../src/local/curation/owner";
import type { Database } from "../src/server/library-store";
const args = process.argv.slice(2),
  arg = (n: string) =>
    args.includes(n) ? args[args.indexOf(n) + 1] : undefined;
if (!arg("--sample") || !arg("--output"))
  throw Error("--sample 및 --output을 지정하세요.");
const sample = JSON.parse(await readFile(arg("--sample")!, "utf8"));
if (!Array.isArray(sample) || sample.length > 100)
  throw Error("최대 100건의 검수 표본만 반영합니다.");
const local = new DatabaseSync(process.env.LIBRARY_PDF_INDEX!, {
  readOnly: true,
});
local.exec("PRAGMA busy_timeout=5000");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL_UNPOOLED,
  max: 1,
});
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
const hash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const result: unknown[] = [];
try {
  const owner = await verifiedCurationOwner(
    db,
    process.env.LIBRARY_OWNER_EMAIL,
  );
  for (const item of sample) {
    if (item.resolution?.state !== "verified" || !item.resolution.record)
      continue;
    const b = await reviewedIdentityBook(db, owner, item.bookId);
    if (!b) continue;
    const verify = () => {
      try {
        const d = local
          .prepare("SELECT * FROM documents WHERE id=?")
          .get(item.documentId) as any;
        if (
          !d ||
          d.processing_scope !== "full" ||
          ["changed", "missing", "error", "locked"].includes(d.status)
        )
          return false;
        const root = realpathSync(process.env.LIBRARY_PDF_ROOT!),
          path = realpathSync(d.path),
          rel = relative(root, path),
          st = statSync(path, { bigint: true });
        if (
          !rel ||
          rel === ".." ||
          rel.startsWith("..\\") ||
          rel.startsWith("../") ||
          isAbsolute(rel) ||
          `${st.size}:${st.mtimeNs}` !== d.signature
        )
          return false;
        const pages = local
          .prepare(
            "SELECT page_number AS pageNumber,text,method FROM pages WHERE document_id=? AND (page_number<=12 OR page_number>max(12,?)) ORDER BY page_number",
          )
          .all(d.id, d.page_count - 8) as unknown as IdentityPage[];
        const fresh = extractPdfIdentity(
          {
            id: d.id,
            title: b.title,
            author: b.author,
            signature: d.signature,
            sha256: d.sha256 ?? "",
            pageCount: Number(d.page_count),
            processingScope: d.processing_scope,
            status: d.status,
          },
          pages,
        );
        return hash(fresh) === hash(item.evidence);
      } catch {
        return false;
      }
    };
    const r = args.includes("--apply")
      ? await applyPdfIdentity(
          db,
          owner,
          b.id,
          item.bookVersion,
          item.evidence,
          item.resolution.record,
          verify,
        )
      : { ready: verify(), applied: false };
    result.push({
      id: b.id,
      documentId: item.documentId,
      title: b.title,
      ...r,
    });
    console.log(JSON.stringify(result[result.length - 1]));
  }
  await writeFile(
    arg("--output")!,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        apply: args.includes("--apply"),
        results: result,
      },
      null,
      2,
    ),
    { flag: "wx", mode: 0o600 },
  );
} finally {
  local.close();
  await pool.end();
}
