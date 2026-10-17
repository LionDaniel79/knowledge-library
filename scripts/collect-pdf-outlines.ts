/** Collect existing PDF bookmarks; never render/OCR or modify an original PDF. */
import { Pool } from "pg";
import { DatabaseSync } from "node:sqlite";
import { realpathSync, statSync } from "node:fs";
import { mkdir, writeFile, rename } from "node:fs/promises";
import { resolve, relative, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { contentHash } from "../src/server/curation-store";
import { buildPdfOutline } from "../src/local/curation/pdf-outline";
import {
  collectPdfOutline,
  retireUnusablePdfOutlines,
} from "../src/local/curation/pdf-outline-store";
import { verifiedCurationOwner } from "../src/local/curation/owner";
import type { Database } from "../src/server/library-store";
const args = process.argv.slice(2),
  apply = args.includes("--apply");
const limit = args.includes("--limit")
  ? Number(args[args.indexOf("--limit") + 1])
  : 5000;
if (!Number.isInteger(limit) || limit < 1 || limit > 5000)
  throw Error("1~5000개 범위를 지정해 주세요.");
const output = resolve(
  process.env.CATALOG_CACHE_DIR || "private-data/catalog",
  "pdf-outlines",
);
await mkdir(output, { recursive: true });
const index = new DatabaseSync(process.env.LIBRARY_PDF_INDEX!, {
  readOnly: true,
});
index.exec("PRAGMA busy_timeout=15000");
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
const stats = {
  startedAt: new Date().toISOString(),
  apply,
  total: 0,
  examined: 0,
  withOutline: 0,
  withoutOutline: 0,
  unavailable: 0,
  applied: 0,
  skipped: 0,
  retired: 0,
  stopped: "running",
};
async function save(name: string, value: unknown) {
  const path = join(output, name),
    temp = path + "." + randomUUID() + ".tmp";
  await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temp, path);
}
function sourceMatches(d: any) {
  try {
    const root = realpathSync(process.env.LIBRARY_PDF_ROOT!),
      file = realpathSync(d.path),
      part = relative(root, file),
      st = statSync(file, { bigint: true });
    return (
      part !== "" &&
      part !== ".." &&
      !part.startsWith("..\\") &&
      !part.startsWith("../") &&
      !isAbsolute(part) &&
      `${st.size}:${st.mtimeNs}` === d.signature
    );
  } catch {
    return false;
  }
}
function outlineFrom(d: any) {
  try {
    return buildPdfOutline(
      {
        id: d.id,
        signature: d.signature,
        pageCount: Number(d.page_count),
        processingScope: d.processing_scope,
        status: d.status,
      },
      JSON.parse(d.toc),
    );
  } catch {
    return null;
  }
}
const rows: Record<string, unknown>[] = [];
try {
  const owner = await verifiedCurationOwner(
    db,
    process.env.LIBRARY_OWNER_EMAIL,
  );
  const books = (
    await pool.query(
      "SELECT b.id,b.title,b.version,d.id AS document_id,EXISTS(SELECT 1 FROM library_curation_items c WHERE c.owner_id=b.owner_id AND c.source_kind='book' AND c.source_id=b.id::text AND c.kind='toc' AND c.origin='rule' AND c.state='active' AND c.reviewed_by IS NULL) AS has_generated_outline FROM library_active_books b JOIN library_documents d ON d.book_id=b.id AND d.owner_id=b.owner_id WHERE b.owner_id=$1 AND d.processing_scope='full' ORDER BY b.id",
      [owner],
    )
  ).rows;
  stats.total = books.length;
  await save("status.json", stats);
  const query = index.prepare(
    "SELECT id,path,signature,page_count,processing_scope,status,toc FROM documents WHERE id=?",
  );
  for (const b of books) {
    if (stats.withOutline >= limit) {
      stats.stopped = "batch_limit";
      break;
    }
    stats.examined++;
    const d = query.get(b.document_id) as any;
    if (!d || !sourceMatches(d)) {
      stats.unavailable++;
      rows.push({
        bookId: b.id,
        documentId: b.document_id,
        state: "source_unavailable",
      });
      continue;
    }
    const outline = outlineFrom(d);
    if (!outline) {
      stats.withoutOutline++;
      if (
        apply &&
        b.has_generated_outline &&
        ["ready", "partial_ocr", "ocr_review", "needs_ocr"].includes(d.status)
      )
        stats.retired += await retireUnusablePdfOutlines(
          db,
          owner,
          { kind: "book", id: b.id, version: String(b.version) },
          {
            id: d.id,
            signature: d.signature,
            pageCount: Number(d.page_count),
            processingScope: d.processing_scope,
            status: d.status,
          },
          () => {
            const current = query.get(d.id) as any;
            return (
              !!current &&
              current.signature === d.signature &&
              sourceMatches(current) &&
              !outlineFrom(current)
            );
          },
        );
      rows.push({ bookId: b.id, documentId: d.id, state: "no_usable_outline" });
      continue;
    }
    stats.withOutline++;
    const hash = contentHash(JSON.stringify(outline));
    const result = apply
      ? await collectPdfOutline(
          db,
          owner,
          { kind: "book", id: b.id, version: String(b.version) },
          outline,
          () => {
            const current = query.get(d.id) as any;
            return (
              !!current &&
              sourceMatches(current) &&
              contentHash(JSON.stringify(outlineFrom(current))) === hash
            );
          },
        )
      : { applied: 0, reason: "확인 전 조사" };
    stats.applied += result.applied;
    if (apply && !result.applied) stats.skipped++;
    const row = {
      bookId: b.id,
      documentId: d.id,
      title: b.title,
      sourceVersion: b.version,
      entries: outline.entries.length,
      ...result,
    };
    rows.push(row);
    await save(`${d.id}.json`, {
      ...row,
      outline,
      at: new Date().toISOString(),
    });
    if (stats.withOutline % 25 === 0) {
      await save("status.json", {
        ...stats,
        updatedAt: new Date().toISOString(),
      });
      console.log(JSON.stringify(stats));
    }
  }
  if (stats.stopped === "running") stats.stopped = "complete";
} catch {
  stats.stopped = "error";
  process.exitCode = 1;
  console.error(
    "PDF 목차 수집 중단: 원본 연결과 저장 상태를 확인해 주세요. 기존 결과는 보존됩니다.",
  );
} finally {
  await save("summary.json", { ...stats, rows });
  await save("status.json", { ...stats, updatedAt: new Date().toISOString() });
  index.close();
  await pool.end();
  console.log(JSON.stringify(stats));
}
