import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { LibraryError } from "../../server/library-store";
import type { PdfCatalogDocument } from "../../server/pdf-catalog-import";
import type { CollectedBook } from "../curation/catalog";

export type ImportState =
  | "scanning"
  | "preview"
  | "registering"
  | "enriching"
  | "indexing"
  | "paused"
  | "complete"
  | "failed";
export type ItemKind =
  "new" | "existing" | "changed" | "excluded" | "review" | "duplicate";
export interface ImportItem {
  document: PdfCatalogDocument;
  kind: ItemKind;
  registered?: boolean;
  bookId?: string;
  indexed?: boolean;
  enriched?: boolean;
  hash?: string;
  error?: string;
  reason?: string;
  records?: CollectedBook[];
  bookVersion?: number;
  reviewed?: boolean;
  ocrPending?: boolean;
}
export interface ImportJob {
  id: string;
  owner: string;
  root: string;
  state: ImportState;
  phase: "scanning" | "registering" | "enriching" | "indexing";
  pauseRequested: boolean;
  updatedAt: number;
  error: string;
}
export class PdfImportJobs {
  private db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,owner TEXT NOT NULL,root TEXT NOT NULL,state TEXT NOT NULL,phase TEXT NOT NULL,pause INTEGER NOT NULL DEFAULT 0,updated INTEGER NOT NULL,worker TEXT,lease INTEGER NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT '');
      CREATE UNIQUE INDEX IF NOT EXISTS active_job ON jobs(owner) WHERE state NOT IN ('complete');
      CREATE TABLE IF NOT EXISTS items(job TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(job,id));
      CREATE TABLE IF NOT EXISTS metadata_cache(key TEXT PRIMARY KEY,data TEXT NOT NULL);`);
  }
  close() {
    this.db.close();
  }
  create(owner: string, root: string): ImportJob {
    if (this.latest(owner)?.state !== "complete" && this.latest(owner))
      throw new LibraryError(
        409,
        "진행 중인 등록 작업을 먼저 완료하거나 취소해 주세요.",
      );
    const id = randomUUID();
    try {
      this.db
        .prepare(
          "INSERT INTO jobs(id,owner,root,state,phase,updated) VALUES(?,?,?,'scanning','scanning',?)",
        )
        .run(id, owner, root, Date.now());
    } catch {
      throw new LibraryError(409, "진행 중인 등록 작업이 있습니다.");
    }
    return this.get(owner, id)!;
  }
  private decode(row: Record<string, unknown> | undefined): ImportJob | null {
    return row
      ? {
          id: String(row.id),
          owner: String(row.owner),
          root: String(row.root),
          state: row.state as ImportState,
          phase: row.phase as ImportJob["phase"],
          pauseRequested: !!row.pause,
          updatedAt: Number(row.updated),
          error: String(row.error),
        }
      : null;
  }
  get(owner: string, id: string) {
    return this.decode(
      this.db
        .prepare("SELECT * FROM jobs WHERE owner=? AND id=?")
        .get(owner, id),
    );
  }
  latest(owner: string) {
    return this.decode(
      this.db
        .prepare(
          "SELECT * FROM jobs WHERE owner=? ORDER BY updated DESC,rowid DESC LIMIT 1",
        )
        .get(owner),
    );
  }
  claim(id: string, worker: string, now = Date.now()) {
    return (
      this.db
        .prepare(
          "UPDATE jobs SET worker=?,lease=?,updated=? WHERE id=? AND state IN ('scanning','registering','enriching','indexing') AND (worker IS NULL OR lease<?)",
        )
        .run(worker, now + 120000, now, id, now).changes === 1
    );
  }
  heartbeat(id: string, worker: string) {
    return (
      this.db
        .prepare("UPDATE jobs SET lease=?,updated=? WHERE id=? AND worker=?")
        .run(Date.now() + 120000, Date.now(), id, worker).changes === 1
    );
  }
  owns(id: string, worker: string) {
    return !!this.db
      .prepare("SELECT id FROM jobs WHERE id=? AND worker=?")
      .get(id, worker);
  }
  startupFailed(id: string) {
    this.db
      .prepare(
        "UPDATE jobs SET state='failed',error='PC 작업자를 시작하지 못했습니다. 설치 경로·Python 설정을 확인하세요.' WHERE id=? AND worker IS NULL",
      )
      .run(id);
  }
  phase(id: string, worker: string, phase: ImportJob["phase"]) {
    this.db
      .prepare(
        "UPDATE jobs SET state=?,phase=?,updated=? WHERE id=? AND worker=?",
      )
      .run(phase, phase, Date.now(), id, worker);
  }
  release(id: string, worker: string, state: ImportState, error = "") {
    this.db
      .prepare(
        "UPDATE jobs SET state=?,error=?,worker=NULL,lease=0,updated=? WHERE id=? AND worker=?",
      )
      .run(state, error, Date.now(), id, worker);
  }
  start(owner: string, id: string) {
    const job = this.required(owner, id);
    if (job.state === "complete")
      throw new LibraryError(
        409,
        "완료된 작업입니다. 폴더를 다시 조사해 주세요.",
      );
    const phase = job.state === "preview" ? "registering" : job.phase;
    this.db
      .prepare(
        "UPDATE jobs SET state=?,phase=?,pause=0,error='',updated=? WHERE owner=? AND id=?",
      )
      .run(phase, phase, Date.now(), owner, id);
    return this.get(owner, id)!;
  }
  retry(owner: string, id: string) {
    const job = this.required(owner, id);
    if (!["complete", "paused", "failed"].includes(job.state))
      throw new LibraryError(409, "먼저 작업을 중지해 주세요.");
    for (const item of this.items(id))
      if (item.error) this.patchItem(id, item.document.id, { error: "" });
    this.db
      .prepare(
        "UPDATE jobs SET state='registering',phase='registering',pause=0,error='',updated=? WHERE owner=? AND id=?",
      )
      .run(Date.now(), owner, id);
    return this.get(owner, id)!;
  }
  pause(owner: string, id: string) {
    this.required(owner, id);
    this.db
      .prepare("UPDATE jobs SET pause=1 WHERE owner=? AND id=?")
      .run(owner, id);
  }
  discard(owner: string, id: string) {
    const job = this.required(owner, id);
    if (!["preview", "paused", "failed"].includes(job.state))
      throw new LibraryError(409, "먼저 작업을 중지해 주세요.");
    this.db
      .prepare(
        "UPDATE jobs SET state='complete',pause=0,updated=? WHERE owner=? AND id=?",
      )
      .run(Date.now(), owner, id);
  }
  required(owner: string, id: string) {
    const j = this.get(owner, id);
    if (!j) throw new LibraryError(404, "등록 작업을 찾을 수 없습니다.");
    return j;
  }
  addItem(
    job: string,
    document: PdfCatalogDocument,
    kind: ItemKind,
    reason = "",
  ) {
    this.db
      .prepare("INSERT OR IGNORE INTO items VALUES(?,?,?)")
      .run(job, document.id, JSON.stringify({ document, kind, reason }));
  }
  items(job: string): ImportItem[] {
    return this.db
      .prepare("SELECT data FROM items WHERE job=? ORDER BY rowid")
      .all(job)
      .map((r) => JSON.parse(String(r.data)));
  }
  item(job: string, id: string): ImportItem | null {
    const r = this.db
      .prepare("SELECT data FROM items WHERE job=? AND id=?")
      .get(job, id);
    return r ? JSON.parse(String(r.data)) : null;
  }
  patchItem(job: string, id: string, patch: Partial<ImportItem>) {
    const item = this.item(job, id);
    if (!item) throw Error("등록 항목 없음");
    this.db
      .prepare("UPDATE items SET data=? WHERE job=? AND id=?")
      .run(JSON.stringify({ ...item, ...patch }), job, id);
  }
  cache(key: string): CollectedBook[] | undefined {
    const r = this.db
      .prepare("SELECT data FROM metadata_cache WHERE key=?")
      .get(key);
    return r ? JSON.parse(String(r.data)) : undefined;
  }
  saveCache(key: string, records: CollectedBook[]) {
    this.db
      .prepare(
        "INSERT INTO metadata_cache VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
      )
      .run(key, JSON.stringify(records));
  }
  summary(owner: string, id?: string, page = 1) {
    const job = id ? this.required(owner, id) : this.latest(owner);
    if (!job) return { job: null };
    const counts: Record<string, number> = {};
    for (const row of this.db
      .prepare(
        "SELECT json_extract(data,'$.kind') AS kind,count(*) AS n FROM items WHERE job=? GROUP BY kind",
      )
      .all(job.id))
      counts[String(row.kind)] = Number(row.n);
    const sums = this.db
      .prepare(
        `SELECT count(*) AS total,
      sum(coalesce(json_extract(data,'$.registered'),0)) AS registered,
      sum(coalesce(json_extract(data,'$.indexed'),0)) AS indexed,
      sum(coalesce(json_extract(data,'$.enriched'),0)) AS enriched,
      sum(coalesce(json_extract(data,'$.ocrPending'),0)) AS ocrPending,
      sum(CASE WHEN coalesce(json_extract(data,'$.error'),'')<>'' THEN 1 ELSE 0 END) AS errors
      FROM items WHERE job=?`,
      )
      .get(job.id)!;
    for (const key of [
      "registered",
      "indexed",
      "enriched",
      "ocrPending",
      "errors",
    ])
      counts[key] = Number(sums[key] ?? 0);
    const condition =
      "(coalesce(json_extract(data,'$.error'),'')<>'' OR json_extract(data,'$.kind') IN ('changed','review') OR (json_array_length(data,'$.records')>0 AND coalesce(json_extract(data,'$.reviewed'),0)=0))";
    const issueCount = Number(
      this.db
        .prepare(`SELECT count(*) AS n FROM items WHERE job=? AND ${condition}`)
        .get(job.id)!.n,
    );
    const issues = this.db
      .prepare(
        `SELECT data FROM items WHERE job=? AND ${condition} ORDER BY rowid LIMIT 15 OFFSET ?`,
      )
      .all(job.id, (page - 1) * 15)
      .map((r) => JSON.parse(String(r.data)) as ImportItem);
    return { job, counts, total: Number(sums.total), issueCount, issues };
  }
}
