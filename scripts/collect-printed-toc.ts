/** Re-runnable extraction of bounded contents-page excerpts. No PDF writes, OCR, or API calls. */
import { Pool } from "pg";
import { DatabaseSync } from "node:sqlite";
import { realpathSync, statSync } from "node:fs";
import { mkdir, writeFile, rename } from "node:fs/promises";
import { resolve, relative, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { contentHash } from "../src/server/curation-store";
import { buildPdfOutline } from "../src/local/curation/pdf-outline";
import {
  buildPrintedToc,
  type PrintedTocPage,
} from "../src/local/curation/printed-toc";
import { collectPrintedToc } from "../src/local/curation/printed-toc-store";
import { verifiedCurationOwner } from "../src/local/curation/owner";
import type { Database } from "../src/server/library-store";

const args = process.argv.slice(2),
  apply = args.includes("--apply");
const arg = (name: string) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const limit = Number(arg("--limit") ?? 5000),
  documentId = arg("--document");
if (!Number.isInteger(limit) || limit < 1 || limit > 5000)
  throw Error("1~5000개 범위를 지정해 주세요.");
if (documentId && !/^[0-9a-f-]{36}$/i.test(documentId))
  throw Error("자료 식별자를 확인해 주세요.");
for (const key of [
  "LIBRARY_PDF_INDEX",
  "LIBRARY_PDF_ROOT",
  "DATABASE_URL_UNPOOLED",
  "CATALOG_CACHE_DIR",
])
  if (!process.env[key]) throw Error("수집 경로와 DB 설정을 확인해 주세요.");
const output = resolve(
  arg("--output") ?? join(process.env.CATALOG_CACHE_DIR!, "printed-toc"),
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
      const result = await fn({ query: (s, p = []) => c.query(s, p) });
      await c.query("COMMIT");
      return result;
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
  candidates: 0,
  embedded: 0,
  waiting: 0,
  noToc: 0,
  unavailable: 0,
  applied: 0,
  skipped: 0,
  stopped: "running",
};
const rows: Record<string, unknown>[] = [];
async function save(name: string, value: unknown) {
  const path = join(output, name),
    temp = path + "." + randomUUID() + ".tmp";
  await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temp, path);
}
async function checkpoint() {
  await save("summary.json", { ...stats, rows });
  await save("status.json", { ...stats, updatedAt: new Date().toISOString() });
}
const query = index.prepare(
  "SELECT id,path,signature,page_count,processing_scope,status,toc FROM documents WHERE id=?",
);
const pageQuery = index.prepare(
  "SELECT page_number AS pageNumber,text,method FROM pages WHERE document_id=? AND (page_number<=40 OR page_number>?) ORDER BY page_number",
);
function pages(d: any): PrintedTocPage[] {
  return pageQuery.all(
    d.id,
    Math.max(40, Number(d.page_count) - 10),
  ) as unknown as PrintedTocPage[];
}
function document(d: any) {
  return {
    id: d.id,
    signature: d.signature,
    pageCount: Number(d.page_count),
    processingScope: d.processing_scope,
    status: d.status,
  };
}
function embedded(d: any) {
  try {
    return buildPdfOutline(document(d), JSON.parse(d.toc));
  } catch {
    return null;
  }
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
try {
  const owner = await verifiedCurationOwner(
    db,
    process.env.LIBRARY_OWNER_EMAIL,
  );
  const books = (
    await pool.query(
      "SELECT b.id,b.title,b.version,d.id AS document_id FROM library_books b JOIN library_documents d ON d.book_id=b.id AND d.owner_id=b.owner_id WHERE b.owner_id=$1 AND d.processing_scope='full' AND ($2::text IS NULL OR d.id::text=$2) ORDER BY b.id",
      [owner, documentId ?? null],
    )
  ).rows;
  stats.total = books.length;
  await checkpoint();
  for (const b of books.slice(0, limit)) {
    stats.examined++;
    const d = query.get(b.document_id) as any;
    let row: Record<string, unknown> = {
      bookId: b.id,
      documentId: b.document_id,
      title: b.title,
      sourceVersion: b.version,
    };
    if (
      !d ||
      d.processing_scope !== "full" ||
      !["ready", "partial_ocr", "ocr_review", "needs_ocr"].includes(d.status) ||
      !sourceMatches(d)
    ) {
      stats.unavailable++;
      row.state = "source_unavailable";
    } else if (embedded(d)) {
      stats.embedded++;
      row.state = "embedded_outline";
    } else {
      const boundary = pages(d),
        toc = buildPrintedToc(document(d), boundary);
      if (!toc) {
        const expected = Math.min(Number(d.page_count), 50);
        const waiting =
          boundary.length < expected ||
          boundary.some((p) => p.method === "needs_ocr");
        if (waiting) stats.waiting++;
        else stats.noToc++;
        row.state = waiting ? "waiting_ocr" : "no_toc_in_checked_pages";
      } else {
        stats.candidates++;
        const hash = contentHash(JSON.stringify(toc));
        const result = apply
          ? await collectPrintedToc(
              db,
              owner,
              { kind: "book", id: b.id, version: String(b.version) },
              toc,
              () => {
                const current = query.get(d.id) as any;
                return (
                  !!current &&
                  sourceMatches(current) &&
                  !embedded(current) &&
                  contentHash(
                    JSON.stringify(
                      buildPrintedToc(document(current), pages(current)),
                    ),
                  ) === hash
                );
              },
            )
          : { applied: 0, reason: "확인 전 조사" };
        stats.applied += result.applied;
        if (apply && !result.applied) stats.skipped++;
        row = {
          ...row,
          state: "candidate",
          pages: toc.pages.map((p) => p.page),
          truncated: toc.truncated,
          ...result,
        };
        await save(`${d.id}.json`, {
          ...row,
          toc,
          at: new Date().toISOString(),
        });
      }
    }
    rows.push(row);
    if (stats.examined % 25 === 0) {
      await checkpoint();
      console.log(JSON.stringify(stats));
    }
  }
  stats.stopped = stats.examined === stats.total ? "complete" : "batch_limit";
} catch {
  stats.stopped = "error";
  process.exitCode = 1;
  console.error(
    "인쇄 목차 수집이 중단되었습니다. 원문 연결과 저장 상태를 확인해 주세요. 기존 결과는 보존됩니다.",
  );
} finally {
  await checkpoint();
  index.close();
  await pool.end();
  console.log(JSON.stringify(stats));
}
