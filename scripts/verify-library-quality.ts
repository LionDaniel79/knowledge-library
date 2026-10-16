/** Read-only acceptance checks against the owner's real catalog and local page index. */
import { Pool } from "pg";
import { writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { searchLibrary } from "../src/server/library-search";
import { readPdfPage, searchPdfPages } from "../src/server/pdf-index";
import { compactTitle } from "../src/lib/bibliography";
import { filterOwnedPdfHits } from "../src/local/curation/review-scope";
const args = process.argv.slice(2),
  output = args[args.indexOf("--output") + 1];
if (!args.includes("--output") || !isAbsolute(output))
  throw Error("비공개 --output 경로 필요");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL_UNPOOLED,
  max: 1,
  connectionTimeoutMillis: 15000,
});
const report: any = {
  at: new Date().toISOString(),
  writes: 0,
  aiCalls: 0,
  catalog: [],
  pages: [],
};
const c = await pool.connect();
try {
  await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  await c.query("SET LOCAL statement_timeout='20s'");
  const owner = (
    await c.query(
      'SELECT id::text FROM neon_auth."user" WHERE lower(email)=lower($1)',
      [process.env.LIBRARY_OWNER_EMAIL],
    )
  ).rows[0]?.id;
  if (!owner) throw Error("서재 소유자 확인 필요");
  for (const query of [
    "정서와 작업하기",
    "인간 본성의 4중상태",
    "개성의 탄생",
    "넥서스",
    "도스토예프스키",
    "시의 문장들",
  ]) {
    console.log(JSON.stringify({ stage: "catalog", query }));
    const start = performance.now(),
      hits = await searchLibrary(c, owner, { text: query, layer: "all" });
    report.catalog.push({
      query,
      durationMs: Math.round(performance.now() - start),
      found: hits.items.length,
      matching: hits.items.filter((r) =>
        compactTitle(r.title + r.quote).includes(compactTitle(query)),
      ).length,
      titles: hits.items.slice(0, 5).map((r) => r.title),
    });
    console.log(JSON.stringify(report.catalog.at(-1)));
  }
  report.thoughtReadiness = (
    await c.query(
      "SELECT (SELECT count(*)::int FROM library_active_notes WHERE owner_id=$1) notes,(SELECT count(*)::int FROM library_thought_events WHERE owner_id=$1) thought_events,(SELECT count(*)::int FROM library_evolution_candidates WHERE owner_id=$1) change_candidates",
      [owner],
    )
  ).rows[0];
  const documents = (
    await c.query(
      "SELECT d.id,d.owner_id,b.owner_id AS book_owner_id,d.processing_scope FROM library_documents d JOIN library_books b ON b.id=d.book_id AND b.owner_id=d.owner_id WHERE d.owner_id=$1",
      [owner],
    )
  ).rows;
  await c.query("COMMIT");
  for (const query of [
    "하이델베르크",
    "삼위일체",
    "정서중심",
    "원자론",
    "기독교강요",
  ]) {
    console.log(JSON.stringify({ stage: "pdf", query }));
    const start = performance.now(),
      hits = filterOwnedPdfHits(owner, searchPdfPages(query), documents);
    const checked = hits.slice(0, 5).map((h) => {
      const p = readPdfPage(h.documentId, h.pageNumber);
      return {
        documentId: h.documentId,
        page: h.pageNumber,
        method: h.extractionMethod,
        quoteMatchesStoredPage: !!p && String(p.text).includes(h.quote),
        signatureMatches: p?.signature === h.signature,
      };
    });
    report.pages.push({
      query,
      expectedHit: query !== "정서중심",
      durationMs: Math.round(performance.now() - start),
      found: hits.length,
      checked,
    });
  }
  report.complete =
    report.catalog.every((r: any) => r.matching > 0) &&
    report.pages.every(
      (r: any) =>
        (!r.expectedHit || r.found > 0) &&
        r.checked.every(
          (p: any) => p.quoteMatchesStoredPage && p.signatureMatches,
        ),
    );
  await writeFile(output, JSON.stringify(report, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
  console.log(JSON.stringify(report));
  if (!report.complete) process.exitCode = 1;
} catch {
  await c.query("ROLLBACK").catch(() => {});
  console.error(
    "실자료 검색 검수 중단. 비공개 설정과 로컬 색인 연결을 확인하세요.",
  );
  process.exitCode = 1;
} finally {
  c.release();
  await pool.end();
}
