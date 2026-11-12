/** Explicit bounded PDF enrichment; never starts a scheduler or writes the OCR index. */
import { Pool } from "pg";
import { DatabaseSync } from "node:sqlite";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { statSync, realpathSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createPoolDatabase } from "../src/server/sync/pool-database";
import { bookSelect, attachCatalogCovers } from "../src/server/book-records";
import {
  extractPdfIdentity,
  resolvePdfIdentity,
} from "../src/local/curation/pdf-identity";
import { metadataPagesTable } from "../src/local/curation/pdf-metadata-pages";
import { readCachedPdfCandidates } from "../src/local/curation/pdf-cached-candidates";
import { logosLookup } from "../src/local/curation/logos-providers";
import { decideAutomaticCandidate } from "../src/local/curation/logos-discovery";
import { applyAutomaticBibliography } from "../src/server/auto-bibliography";
import { acquireYes24Lock } from "../src/local/curation/yes24-batch";
import { atomicWriteJson } from "../src/local/atomic-json";
import {
  pdfProgressFingerprint,
  pdfProgressReady,
  pdfProgressResult,
  pdfCandidateStamp,
  type PdfProgress,
} from "../src/local/curation/pdf-progress";
const args = process.argv.slice(2),
  apply = args.includes("--apply"),
  limit = Number(args[args.indexOf("--limit") + 1] || 20);
if (!Number.isInteger(limit) || limit < 1 || limit > 100)
  throw Error("Limit must be 1..100");
const root = process.env.LIBRARY_PDF_ROOT!,
  index = process.env.LIBRARY_PDF_INDEX!,
  cache = process.env.CATALOG_CACHE_DIR!,
  owner = process.env.LIBRARY_CATALOG_OWNER_ID!,
  out = process.env.PDF_AUTO_REPORT_DIR!;
if (!root || !index || !cache || !owner || !out)
  throw Error("PDF operator configuration required");
if (apply && process.env.LIBRARY_STAGE5_WRITE_ENABLED !== "true")
  throw Error("Writes disabled");
await mkdir(out, { recursive: true });
const progressDir = join(
  cache,
  "pdf-auto",
  "progress",
  createHash("sha256").update(owner).digest("hex"),
);
await mkdir(progressDir, { recursive: true });
let release: () => void;
try {
  release = acquireYes24Lock(join(cache, "pdf-auto", "worker.sqlite"));
} catch {
  console.log(JSON.stringify({ stopped: "busy", processed: 0, applied: 0 }));
  process.exit(0);
}
const p = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 15000,
    query_timeout: 60000,
    statement_timeout: 60000,
  }),
  db = createPoolDatabase(p),
  local = new DatabaseSync(index, { readOnly: true });
local.exec("PRAGMA busy_timeout=10000");
const stats: any = {
  apply,
  scanned: 0,
  processed: 0,
  eligible: 0,
  applied: 0,
  cover: 0,
  fields: {},
  missing: 0,
  review: 0,
  errors: 0,
  sourceUnavailable: 0,
  frontierPagesRead: 0,
  supplemented: 0,
  ocr: 0,
  verifiedOriginalIsbn: 0,
  withoutIsbnApplied: 0,
  calls: { library: 0, yes24: 0, images: 0 },
  stopped: "complete",
  skippedCheckpoint: 0,
  legacyReused: 0,
  cacheReused: 0,
};
const investigated = new Set<string>();
const fetcher: typeof fetch = async (...a) => {
  const h = new URL(String(a[0])).hostname;
  if (
    ["data4library.kr", "apis.yes24.com"].includes(h) &&
    stats.calls.library + stats.calls.yes24 >= 160
  )
    throw Object.assign(Error("Finite API budget reached"), {
      code: "PDF_API_BUDGET",
    });
  stats.calls[
    h === "data4library.kr"
      ? "library"
      : h === "apis.yes24.com"
        ? "yes24"
        : "images"
  ]++;
  return fetch(...a);
};
const lookup = logosLookup({
  dir: join(cache, "pdf-auto", "providers"),
  libraryKey: process.env.DATA4LIBRARY_KEY,
  yes24Key: process.env.YES24_API_KEY,
  fetcher,
});
let supplements = 0;
try {
  const rows = (
    await p.query(
      `SELECT ${bookSelect} FROM library_active_books WHERE owner_id=$1 AND 'pdf'=ANY(formats) AND source_data->>'app'='Local PDF' AND enrichment->'autoBibliography' IS NULL ORDER BY (trim(isbn)<>'') DESC,id`,
      [owner],
    )
  ).rows;
  await attachCatalogCovers(db, owner, rows);
  for (const b of rows) {
    if (
      process.env.COLLECTION_STOP_AT &&
      Date.now() >= Number(process.env.COLLECTION_STOP_AT)
    ) {
      stats.stopped = "paused";
      break;
    }
    if (stats.processed >= limit) break;
    if (
      b.author &&
      b.publisher &&
      b.category &&
      b.enrichment?.auto_description &&
      b.enrichment?.auto_toc?.length &&
      b.enrichment?.auto_publicationYear &&
      (b.isbn || b.enrichment?.auto_referenceIsbn)
    )
      continue;
    stats.scanned++;
    const d = local
      .prepare("SELECT * FROM documents WHERE id=?")
      .get(b.sourceData.recordId) as any;
    const progressPath = join(progressDir, b.id + ".json");
    let previous: PdfProgress | undefined;
    try {
      previous = JSON.parse(await readFile(progressPath, "utf8"));
    } catch {}
    const unavailableKey = pdfProgressFingerprint(b, d, undefined);
    if (
      !d ||
      d.processing_scope !== "full" ||
      /paper|periodical|journal|thesis/.test(d.material_kind)
    ) {
      if (!pdfProgressReady(previous, unavailableKey)) {
        stats.skippedCheckpoint++;
        continue;
      }
      stats.processed++;
      investigated.add(b.id);
      await atomicWriteJson(
        progressPath,
        pdfProgressResult(previous, unavailableKey, "source_unavailable"),
      );
      stats.sourceUnavailable++;
      continue;
    }
    let stamp;
    try {
      const file = realpathSync(d.path),
        rel = relative(realpathSync(root), file);
      stamp = statSync(file, { bigint: true });
      if (
        !rel ||
        rel.startsWith("..") ||
        isAbsolute(rel) ||
        String(stamp.size) !== String(d.bytes) ||
        String(stamp.mtimeNs) !== String(d.mtime_ns)
      )
        throw Error();
    } catch {
      if (!pdfProgressReady(previous, unavailableKey)) {
        stats.skippedCheckpoint++;
        continue;
      }
      stats.processed++;
      investigated.add(b.id);
      await atomicWriteJson(
        progressPath,
        pdfProgressResult(previous, unavailableKey, "source_unavailable"),
      );
      stats.sourceUnavailable++;
      continue;
    }
    const pages = local
      .prepare(
        `SELECT page_number AS pageNumber,text,method FROM ${metadataPagesTable(local)} WHERE document_id=? AND (page_number<=12 OR page_number>?) ORDER BY page_number`,
      )
      .all(d.id, Math.max(12, d.page_count - 8)) as any[];
    stats.frontierPagesRead += pages.length;
    let evidence = extractPdfIdentity(
      {
        id: d.id,
        title: b.title,
        author: b.author,
        signature: d.signature,
        sha256: d.sha256 ?? "",
        pageCount: d.page_count,
        processingScope: d.processing_scope,
        status: d.status,
      },
      pages,
    );
    const legacyKey = createHash("sha256")
      .update(
        JSON.stringify([b.id, b.version, d.signature, evidence.candidates]),
      )
      .digest("hex");
    let legacy: any;
    try {
      legacy = JSON.parse(
        await readFile(
          join(
            process.env.PDF_AUTO_LEGACY_REPORT_DIR ?? out,
            legacyKey + ".json",
          ),
          "utf8",
        ),
      );
    } catch {}
    const fingerprintEvidence = evidence;
    const makeFingerprint = async () =>
      pdfProgressFingerprint(
        b,
        d,
        fingerprintEvidence,
        JSON.stringify([
          legacy?.records,
          await pdfCandidateStamp(join(cache, "pdf-auto", "providers"), b),
        ]),
      );
    const fingerprint = await makeFingerprint();
    const checkpoint = async (state: string) =>
      atomicWriteJson(
        progressPath,
        pdfProgressResult(previous, await makeFingerprint(), state),
      );
    if (!pdfProgressReady(previous, fingerprint)) {
      stats.skippedCheckpoint++;
      continue;
    }
    if (!previous && legacy?.records) {
      const checked = decideAutomaticCandidate(
        {
          ...b,
          resourceId: d.id,
          publicationDate: "",
          edition: "",
          resourceType: "",
        },
        legacy.records,
      );
      if (checked.state !== "certain") {
        await checkpoint(checked.state);
        stats.legacyReused++;
        continue;
      }
    }
    if (evidence.state === "excluded") {
      stats.processed++;
      investigated.add(b.id);
      await checkpoint("source_unavailable");
      stats.sourceUnavailable++;
      continue;
    }
    const absent = [
      ...new Set([
        ...evidence.missingPages,
        ...evidence.pendingOcrPages,
        ...evidence.unresolvedPages,
      ]),
    ].slice(0, 20 - supplements);
    if (absent.length) {
      supplements += absent.length;
      try {
        const reply = JSON.parse(
          execFileSync(
            process.env.PDF_IDENTITY_PYTHON!,
            [join(process.cwd(), "scripts/pdf_identity_frontier.py")],
            {
              input: JSON.stringify({
                path: d.path,
                pages: absent,
                pageCount: d.page_count,
                cache:
                  process.env.PDF_FRONTIER_CACHE_DIR ?? join(out, "frontier"),
              }),
              encoding: "utf8",
              windowsHide: true,
              env: {
                ...process.env,
                PYTHONUTF8: "1",
                PYTHONIOENCODING: "utf-8",
              },
              timeout: 180000,
              maxBuffer: 4000000,
            },
          ),
        );
        if (reply.error) throw Error();
        stats.supplemented += reply.pages.length;
        stats.ocr += reply.pages.filter(
          (x: any) => x.ocr && !x.cacheHit,
        ).length;
        const replaced = new Set(reply.pages.map((x: any) => x.pageNumber));
        evidence = extractPdfIdentity(evidence, [
          ...pages.filter((x) => !replaced.has(x.pageNumber)),
          ...reply.pages,
        ]);
      } catch {
        stats.errors++;
      }
    }
    stats.processed++;
    investigated.add(b.id);
    const key = createHash("sha256")
        .update(
          JSON.stringify([b.id, b.version, d.signature, evidence.candidates]),
        )
        .digest("hex"),
      attempt = join(out, key + ".json");
    let records: any[] = [];
    const expired =
      previous?.fingerprint === fingerprint &&
      previous.nextAttemptAt <= Date.now();
    const changed = !!previous && previous.fingerprint !== fingerprint;
    try {
      const previous = JSON.parse(await readFile(attempt, "utf8"));
      if (previous.state === "lookup_error") {
        throw Error("Lookup retry due");
      }
      if (expired || changed) throw Error("Lookup expired or changed");
      records = previous.records;
      stats.cacheReused++;
    } catch {
      const hit =
        expired || changed
          ? { records: [], titleResults: [] }
          : await readCachedPdfCandidates(cache, b, evidence);
      records = [
        ...hit.records,
        ...hit.titleResults.flatMap((x) =>
          x.books.map((r: any) => ({
            provider: "도서관 정보나루",
            url: r.url,
            isbn: r.isbn,
            title: r.title,
            facts: r,
            description: r.description,
          })),
        ),
      ];
      if (!records.length) {
        const isbn =
          b.isbn ||
          evidence.candidates.find((x) =>
            x.evidence.some((e) => e.labelled && !e.secondaryContext),
          )?.isbn ||
          "";
        try {
          records = await lookup({
            ...b,
            resourceId: d.id,
            publicationDate: "",
            edition: "",
            resourceType: "",
            isbn,
          });
        } catch (e: any) {
          if (e.status && [400, 404, 422].includes(e.status)) {
            stats.errors++;
            await checkpoint("error");
            await writeFile(
              attempt,
              JSON.stringify({ records: [], state: "lookup_error" }),
            );
            continue;
          }
          throw e;
        }
      }
      await writeFile(attempt, JSON.stringify({ records, evidence }));
    }
    const resolution = resolvePdfIdentity(evidence, records);
    if (resolution.state === "verified") stats.verifiedOriginalIsbn++;
    const decision = decideAutomaticCandidate(
      {
        ...b,
        ...(!b.isbn &&
        evidence.candidates.length === 1 &&
        !evidence.missingPages.length &&
        !evidence.pendingOcrPages.length &&
        evidence.candidates[0].evidence.some(
          (e) => e.labelled && !e.secondaryContext,
        )
          ? { isbn: evidence.candidates[0].isbn }
          : {}),
        resourceId: d.id,
        publicationDate: "",
        edition: "",
        resourceType: "",
      },
      records,
    );
    if (decision.state !== "certain") {
      stats[decision.state === "review" ? "review" : "missing"]++;
      await checkpoint(decision.state);
      continue;
    }
    stats.eligible++;
    await writeFile(
      join(out, b.id + "-before.json"),
      JSON.stringify({ book: b, evidence, record: decision.record }),
    );
    if (apply) {
      const now = statSync(d.path, { bigint: true });
      if (now.mtimeNs !== stamp.mtimeNs || now.size !== stamp.size)
        throw Error("Source changed");
      const { downloadCover } = await import("../src/server/cover-download");
      let result: any;
      try {
        result = await applyAutomaticBibliography(
          db,
          owner,
          b.id,
          Number(b.version),
          decision.record!,
          (url) => downloadCover(url, fetcher),
          evidence,
          !!(
            b.coverUrl ||
            b.catalogCoverUrl ||
            b.storedCoverUrl ||
            b.sourceData?.cover
          ),
        );
      } catch (e: any) {
        if ([400, 404, 413, 502].includes(e.status)) {
          stats.errors++;
          await checkpoint("error");
          continue;
        }
        throw e;
      }
      if (result.state === "applied") {
        await checkpoint("applied");
        stats.applied++;
        if (
          !b.isbn &&
          !evidence.candidates.some((x) =>
            x.evidence.some((e) => e.labelled && !e.secondaryContext),
          )
        )
          stats.withoutIsbnApplied++;
        for (const f of result.fields ?? []) {
          stats.fields[f] = (stats.fields[f] ?? 0) + 1;
          if (f === "coverUrl") stats.cover++;
        }
      } else await checkpoint(result.state);
    }
  }
} catch (e: any) {
  stats.stopped = e.code === "PDF_API_BUDGET" ? "budget" : "error";
  stats.error = { name: e.name, code: e.code, status: e.status };
  process.exitCode = stats.stopped === "budget" ? 0 : 1;
} finally {
  local.close();
  await p.end();
  release();
  await writeFile(
    join(out, apply ? "applied.json" : "preview.json"),
    JSON.stringify(stats, null, 2),
  );
  await atomicWriteJson(join(out, "investigated.json"), {
    at: new Date().toISOString(),
    ids: [...investigated],
  });
  console.log(JSON.stringify(stats));
}
