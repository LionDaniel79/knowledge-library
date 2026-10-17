/** Read-only verification of source data; browser writes use an isolated generated fixture. */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { chromium, webkit } from "@playwright/test";
import sharp from "sharp";
import {
  syncEntities,
  syncKey,
  type SyncEntity,
} from "../src/lib/replica/entities";
import {
  createSyncCursor,
  parseSyncCursor,
  VALUE_PART_BYTES,
  type SyncRow,
} from "../src/lib/replica/contracts";
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((v, i, a) => (v.startsWith("--") ? [v.slice(2), a[i + 1]] : []))
    .filter((v) => v.length),
);
assert.equal(args.mode, "verify-only", "Use --mode verify-only");
if (args.source === "database") {
  const { Pool } = await import("pg"),
    { createPoolDatabase } = await import("../src/server/sync/pool-database"),
    { readSyncMeta } = await import("../src/server/sync/read"),
    { readSyncCoverage } = await import("../src/server/sync/coverage");
  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL,
    max: 1,
    options: "-c default_transaction_read_only=on",
    statement_timeout: 120000,
  });
  try {
    const owner = (
      await pool.query(
        'SELECT id::text FROM neon_auth."user" WHERE lower(email)=lower($1)',
        [process.env.LIBRARY_OWNER_EMAIL],
      )
    ).rows[0]?.id;
    assert(owner, "Configured library owner is required");
    const db = createPoolDatabase(pool),
      start = Date.now(),
      meta = await readSyncMeta(db, owner),
      coverage = await readSyncCoverage(db, owner);
    console.log(
      JSON.stringify(
        {
          source: "database-read-only",
          tables: Object.keys(coverage.entities).length,
          rows: meta.totalRows,
          bytes: meta.totalBytes,
          epoch: meta.epoch,
          head: meta.head,
          coverage: coverage.entities,
          milliseconds: Date.now() - start,
        },
        null,
        2,
      ),
    );
  } finally {
    await pool.end();
  }
  process.exit(0);
}
assert.equal(args.source ?? "generated", "generated");
const catalogSample = args.sample === "catalog";
const owner = "generated-scale",
  epoch = crypto.randomUUID(),
  rows = new Map<SyncEntity, SyncRow[]>(),
  values = new Map<string, Buffer>(),
  coverage: any = {},
  counts: any = {
    library_books: 6000,
    library_notes: 1000,
    library_cover_assets: catalogSample ? 32 : 3285,
    library_imports: catalogSample ? 1 : 40000,
    library_revisions: catalogSample ? 1 : 109715,
  };
const target = (catalogSample ? 12 : 222) * 1024 ** 2,
  date = "2026-10-17T01:00:00Z",
  id = (i: number) =>
    `00000000-0000-4000-8000-${i.toString().padStart(12, "0")}`,
  hash = (value: string | Buffer) =>
    createHash("sha256").update(value).digest("hex");
const image = await sharp(randomBytes(100 * 150 * 3), {
  raw: { width: 100, height: 150, channels: 3 },
})
  .webp({ quality: 70 })
  .toBuffer();
let totalBytes = 0,
  totalRows = 0;
function add(entity: SyncEntity, value: any) {
  const raw = Buffer.from(JSON.stringify(value)),
    key = syncKey(entity, value),
    sha256 = hash(raw),
    row: SyncRow = {
      entity,
      key,
      sha256,
      revision: "1",
      deleted: false,
      bytes: raw.length,
    };
  if (raw.length <= 8192) row.inline = raw.toString();
  else {
    row.parts = Array.from(
      { length: Math.ceil(raw.length / VALUE_PART_BYTES) },
      (_, index) => {
        const part = raw.subarray(
          index * VALUE_PART_BYTES,
          (index + 1) * VALUE_PART_BYTES,
        );
        return { index, bytes: part.length, sha256: hash(part) };
      },
    );
    values.set(entity + "\0" + key, raw);
  }
  rows.get(entity)!.push(row);
  totalBytes += raw.length;
  totalRows++;
}
for (const entity of Object.keys(syncEntities) as SyncEntity[])
  rows.set(entity, []);
for (const entity of [
  "library_books",
  "library_notes",
  "library_cover_assets",
  "library_imports",
  "library_revisions",
] as SyncEntity[]) {
  const count = counts[entity];
  const revisionSize =
    entity === "library_revisions"
      ? Math.floor((target - totalBytes) / count)
      : 0;
  for (let i = 1; i <= count; i++) {
    const value: any = { id: id(i), created_at: date };
    let field = "",
      size = 0;
    if (entity === "library_books") {
      Object.assign(value, {
        title: "도서 " + i.toString().padStart(5, "0"),
        author: "저자 " + (i % 100),
        publisher: "출판사",
        isbn: "",
        formats: ["paper"],
        total_pages: 200,
        shelf: "",
        tags: [],
        category: "100",
        bookshelves: [],
        classification: {},
        enrichment: {},
        cover_url: "/api/book-covers/" + id((i % 3285) + 1),
        version: 1,
      });
      field = "source_data";
      size = 600;
    }
    if (entity === "library_notes") {
      Object.assign(value, {
        title: "생각 " + i,
        content: "직접 쓴 기록",
        book_id: id((i % 6000) + 1),
        kind: "thought",
        page: null,
        tags: [],
        version: 1,
        updated_at: date,
      });
      field = "source_data";
      size = 800;
    }
    if (entity === "library_cover_assets")
      Object.assign(value, {
        mime: "image/webp",
        sha256: hash(image),
        data_base64: image.toString("base64"),
      });
    if (entity === "library_imports") {
      field = "original_data";
      size = i === 1 ? 4.5 * 1024 ** 2 : 2000;
    }
    if (entity === "library_revisions") {
      Object.assign(value, {
        entity_id: id((i % 1000) + 1),
        action: "editNote",
        before_data: null,
      });
      field = "after_data";
      size = revisionSize;
    }
    if (field) {
      value[field] = { fixture: "" };
      const needed = Math.max(
        0,
        Math.floor(size) - Buffer.byteLength(JSON.stringify(value)),
      );
      value[field].fixture = "x".repeat(needed);
    }
    add(entity, value);
  }
}
for (const [entity, list] of rows) {
  list.sort((a, b) => (a.key < b.key ? -1 : 1));
  const h = createHash("sha256");
  for (const r of list) h.update(r.key + "\t" + r.sha256 + "\n");
  coverage[entity] = { rows: list.length, sha256: h.digest("hex") };
}
assert.equal(totalRows, catalogSample ? 7034 : 160000);
assert(
  totalBytes >= (catalogSample ? 11 : 221) * 1024 ** 2 &&
    totalBytes <= (catalogSample ? 13 : 223) * 1024 ** 2,
);
const meta = (inventory: boolean) => ({
  epoch,
  head: "1",
  floor: "0",
  protocol: 1,
  entities: inventory
    ? Object.fromEntries(
        [...rows].map(([e, r]) => [
          e,
          { rows: r.length, bytes: r.reduce((n, v) => n + v.bytes, 0) },
        ]),
      )
    : {},
  totalRows: inventory ? totalRows : 0,
  totalBytes: inventory ? totalBytes : 0,
});
let responseBytes = 0,
  maxResponse = 0,
  valueCalls = 0,
  headCalls = 0,
  rss = process.memoryUsage().rss;
const paths: Record<string, number> = {};
const js = (
  await build({
    stdin: {
      contents: `import{openReplica}from'./src/client/replica/indexed-db';import{bootstrapReplica}from'./src/client/replica/bootstrap';import{createSyncTransport}from'./src/client/replica/transport';import{createReplicaRepository}from'./src/client/replica/repository';import{createReplicaCoordinator}from'./src/client/replica/coordinator';window.runScale=async(interrupt)=>{const storage=await openReplica('generated-scale'),transport=createSyncTransport(),abort=new AbortController();window.measurements={scan:0,transaction:0,read:0};for(const [obj,key,label]of [[transport,'scan','scan'],[storage,'transaction','transaction'],[storage,'readPage','read']]){const original=obj[key].bind(obj);obj[key]=async(...args)=>{const at=performance.now();try{return await original(...args);}finally{window.measurements[label]+=performance.now()-at;}};}const before=await navigator.storage.estimate();try{await bootstrapReplica({owner:storage.owner,storage,transport,signal:abort.signal,onProgress:p=>{window.progress=p.rows;if(interrupt&&p.rows>=${catalogSample ? 500 : 30000})abort.abort();}});}catch(e){if(!abort.signal.aborted)throw e;const cp=(await storage.listGenerations())[0];storage.close();return{interrupted:true,rows:cp.rows,bytes:cp.bytes};}const cp=await storage.checkpoint(),repo=createReplicaRepository(storage);const cold=performance.now();await repo.books();const coldMs=performance.now()-cold,times=[];for(let i=0;i<50;i++){const t=performance.now();await repo.books({sort:i%2?'title':'newest',limit:30});times.push(performance.now()-t);}times.sort((a,b)=>a-b);const after=await navigator.storage.estimate();const coordinator=createReplicaCoordinator({owner:storage.owner,storage,transport});await fetch('/reset-metrics',{method:'POST'});await coordinator.syncReplica({reason:'unchanged'});const network=await(await fetch('/metrics')).json();const result={rows:cp.rows,bytes:cp.bytes,complete:cp.complete,coldMs,p95:times[Math.ceil(times.length*.95)-1],storageBefore:before.usage,storageAfter:after.usage,quota:after.quota,jsHeap:performance.memory?.usedJSHeapSize??null,network};repo.close();storage.close();return result;};`,
      loader: "ts",
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    define: { "import.meta.url": "location.href" },
  })
).outputFiles[0].text;
const worker = (
  await build({
    entryPoints: ["src/client/replica/search-worker.ts"],
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
  })
).outputFiles[0].text;
const server = createServer((req, res) => {
  try {
    const u = new URL(req.url!, "http://localhost"),
      q = Object.fromEntries(u.searchParams);
    let body: any;
    if (u.pathname === "/") {
      res.setHeader("Content-Type", "text/html");
      return res.end(
        '<meta name="viewport" content="width=device-width,initial-scale=1"><script src="/main.js"></script>',
      );
    }
    if (u.pathname === "/main.js" || u.pathname === "/search-worker.ts") {
      res.setHeader("Content-Type", "application/javascript");
      return res.end(u.pathname === "/main.js" ? js : worker);
    }
    if (u.pathname === "/reset-metrics") {
      responseBytes = 0;
      maxResponse = 0;
      headCalls = 0;
      valueCalls = 0;
      for (const k of Object.keys(paths)) delete paths[k];
      return res.end("{}");
    }
    if (u.pathname === "/metrics") {
      res.setHeader("Content-Type", "application/json");
      return res.end(
        JSON.stringify({
          responseBytes,
          maxResponse,
          valueCalls,
          headCalls,
          paths,
        }),
      );
    }
    if (u.pathname === "/api/sync/meta") {
      headCalls++;
      body = meta(q.inventory === "1");
    } else if (u.pathname === "/api/sync/coverage")
      body = { epoch, head: "1", entities: coverage };
    else if (u.pathname === "/api/sync/changes")
      body = {
        epoch,
        head: "1",
        rows: [],
        cursor: createSyncCursor({ owner, epoch, after: "1" }),
        hasMore: false,
      };
    else if (u.pathname === "/api/sync/scan") {
      const entity = q.entity as SyncEntity,
        list = rows.get(entity)!;
      const key = q.after
        ? parseSyncCursor(q.after, owner, epoch).key
        : undefined;
      const start = key ? list.findIndex((r) => r.key === key) + 1 : 0;
      let selected = list.slice(start, start + 200);
      const page = () => ({
        epoch,
        head: "1",
        rows: selected,
        cursor: createSyncCursor({
          owner,
          epoch,
          after: "1",
          entity,
          ...(selected.length
            ? { key: selected.at(-1)!.key }
            : key
              ? { key }
              : {}),
        }),
        hasMore: start + selected.length < list.length,
      });
      body = page();
      while (Buffer.byteLength(JSON.stringify(body)) > 512 * 1024) {
        selected = selected.slice(0, -1);
        body = page();
      }
    } else if (u.pathname === "/api/sync/value") {
      const data = values.get(q.entity + "\0" + q.key)!;
      const part = data.subarray(
        Number(q.index) * VALUE_PART_BYTES,
        (Number(q.index) + 1) * VALUE_PART_BYTES,
      );
      valueCalls++;
      responseBytes += part.length;
      maxResponse = Math.max(maxResponse, part.length);
      paths[u.pathname] = (paths[u.pathname] ?? 0) + 1;
      return res.end(part);
    } else {
      res.statusCode = 404;
      body = { error: "Fixture route missing" };
    }
    const raw = JSON.stringify(body);
    responseBytes += Buffer.byteLength(raw);
    maxResponse = Math.max(maxResponse, Buffer.byteLength(raw));
    paths[u.pathname] = (paths[u.pathname] ?? 0) + 1;
    res.setHeader("Content-Type", "application/json");
    res.end(raw);
  } catch {
    res.statusCode = 500;
    res.end('{"error":"Fixture failure"}');
  }
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${(server.address() as any).port}`;
const cacheRoot = resolve(
  args.scratch ?? "D:/지식서재 작업/cache/replica-scale",
);
await mkdir(cacheRoot, { recursive: true });
const profile = await mkdtemp(resolve(cacheRoot, "generated-"));
const engine = args.browser === "webkit" ? webkit : chromium,
  context = await engine.launchPersistentContext(profile, { headless: true });
const sampling = setInterval(() => {
  rss = Math.max(rss, process.memoryUsage().rss);
}, 1000);
try {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.bringToFront();
  await page.goto(origin);
  await page.waitForFunction(() => !!(window as any).runScale);
  console.log(
    JSON.stringify({
      phase: "generated-start",
      tables: 38,
      rows: totalRows,
      bytes: totalBytes,
      profile,
    }),
  );
  const interval = setInterval(() => {
    void page
      .evaluate(() => ({
        rows: (window as any).progress,
        times: (window as any).measurements,
      }))
      .then((progress) =>
        console.log(JSON.stringify({ phase: "receiving", ...progress })),
      )
      .catch(() => {});
  }, 15000);
  let interrupted: any, result: any;
  try {
    interrupted = await page.evaluate(() => (window as any).runScale(true));
    assert(
      interrupted.interrupted &&
        interrupted.rows >= (catalogSample ? 500 : 30000),
    );
    await page.reload();
    await page.waitForFunction(() => !!(window as any).runScale);
    result = await page.evaluate(() => (window as any).runScale(false));
  } finally {
    clearInterval(interval);
  }
  assert.equal(result.rows, totalRows);
  assert.equal(result.bytes, totalBytes);
  assert(result.complete);
  assert(result.network.responseBytes <= 4096);
  assert.equal(result.network.valueCalls, 0);
  assert.equal(result.network.headCalls, 1);
  const report = {
    source: "generated-only",
    browser: args.browser ?? "chromium",
    tables: 38,
    interrupted,
    result,
    nodePeakRss: rss,
    fixtureHasExternalPdf: false,
  };
  console.log(JSON.stringify(report, null, 2));
  if (args.output)
    await writeFile(args.output, JSON.stringify(report, null, 2));
} finally {
  clearInterval(sampling);
  await context.close();
  await new Promise<void>((r) => {
    server.close(() => r());
    server.closeAllConnections();
  });
}
