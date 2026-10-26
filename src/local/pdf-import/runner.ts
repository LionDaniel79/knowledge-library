import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Database } from "../../server/library-store";
import { importPdfCatalog } from "../../server/pdf-catalog-import";
import {
  applyPdfConnection,
  previewPdfConnection,
  verifiedPdfRoot,
} from "../../server/pdf-reconnect";
import type { CollectedBook } from "../curation/catalog";
import { PdfImportJobs } from "./jobs";
import {
  applyImportMetadata,
  extractPdfIdentity,
  importMetadataCandidates,
  resolvePdfIdentity,
  type IdentityPage,
  type PdfIdentity,
} from "./metadata";
import type { PdfRpc } from "./python";

export function localHashes(): Map<string, string> {
  const path = process.env.LIBRARY_PDF_INDEX;
  if (!path || !existsSync(path)) return new Map();
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=5000");
    return new Map(
      db
        .prepare(
          "SELECT id,sha256 FROM documents WHERE sha256 IS NOT NULL AND sha256<>''",
        )
        .all()
        .map((r) => [String(r.id), String(r.sha256)]),
    );
  } finally {
    db.close();
  }
}
async function documents(db: Database, owner: string) {
  return (
    await db.query(
      "SELECT d.*,e.state AS exclusion FROM library_documents d LEFT JOIN library_book_exclusions e ON e.owner_id=d.owner_id AND e.id=d.book_id WHERE d.owner_id=$1",
      [owner],
    )
  ).rows;
}
export async function runPdfImport(
  db: Database,
  jobs: PdfImportJobs,
  owner: string,
  id: string,
  rpc: PdfRpc,
  options: {
    existingHashes?: () => Map<string, string>;
    connectRoot?: (root: string) => Promise<void>;
    connectedRoot?: () => Promise<string | null>;
    metadata?: (evidence: PdfIdentity) => Promise<CollectedBook[]>;
  } = {},
) {
  const worker = randomUUID();
  if (!jobs.claim(id, worker)) {
    rpc.close();
    return;
  }
  const heartbeat = setInterval(() => jobs.heartbeat(id, worker), 15000);
  const stop = () => {
    const j = jobs.required(owner, id);
    return j.pauseRequested || !jobs.owns(id, worker);
  };
  try {
    let job = jobs.required(owner, id);
    if (job.phase === "scanning") {
      const current = await documents(db, owner),
        byPath = new Map(current.map((d) => [resolve(d.path), d]));
      const connectedRoot = await (
        options.connectedRoot ?? (() => verifiedPdfRoot(owner))
      )();
      if (connectedRoot && resolve(connectedRoot) === resolve(job.root)) {
        for (const old of current)
          byPath.set(resolve(job.root, old.relative_path), old);
      }
      await rpc.call("inventory", {}, (doc) => {
        const old = byPath.get(resolve(doc.path));
        const kind =
          old?.exclusion === "excluded"
            ? "excluded"
            : old
              ? String(old.bytes) === String(doc.bytes) &&
                old.mtime_ns === doc.mtime_ns
                ? "existing"
                : "changed"
              : doc.material_kind === "paper" ||
                  doc.material_kind === "periodical"
                ? "excluded"
                : doc.processing_scope !== "full"
                  ? "review"
                  : "new";
        jobs.addItem(
          id,
          doc,
          kind,
          kind === "changed"
            ? "기존 원본 변경: 인용 보존을 위해 자동 교체하지 않음"
            : doc.scope_reason,
        );
      });
      jobs.release(id, worker, stop() ? "paused" : "preview");
      return;
    }
    // The folder must be the configured/verified connection once documents exist.
    if (options.connectRoot) await options.connectRoot(job.root);
    else {
      const connection = await import("../../server/pdf-reconnect").then((m) =>
        m.pdfConnectionState(),
      );
      if (
        resolve(connection.root ?? "") !== resolve(job.root) &&
        (await documents(db, owner)).length
      )
        throw Error("먼저 연결 검사 후 이 위치로 저장해 주세요.");
      if (!(await documents(db, owner)).length) {
        const p = await previewPdfConnection(db, owner, { root: job.root });
        await applyPdfConnection(db, owner, {
          ...p,
          expectedVersion: p.version,
        });
      }
    }
    const setPhase = (phase: "registering" | "enriching" | "indexing") => {
      jobs.phase(id, worker, phase);
      job = jobs.required(owner, id);
    };
    setPhase("registering");
    const current = await documents(db, owner),
      hashes = (options.existingHashes ?? localHashes)();
    const byHash = new Map<string, string>();
    for (const d of current)
      if (hashes.get(d.id)) byHash.set(hashes.get(d.id)!, d.id);
    const candidates = jobs.items(id).filter((i) => i.kind === "new");
    const sizes = new Set(candidates.map((i) => String(i.document.bytes)));
    const unresolvedExcludedSizes = new Set<string>();
    for (const old of current) {
      if (!sizes.has(String(old.bytes)) || hashes.has(old.id)) continue;
      if (stop()) break;
      try {
        const path = join(job.root, old.relative_path),
          s = await stat(path, { bigint: true });
        // A matching stat signature is required before deriving the missing original hash.
        if (
          String(s.size) !== String(old.bytes) ||
          s.mtimeNs.toString() !== old.mtime_ns
        )
          throw Error();
        const hash = await rpc.call<string>("hash", {
          document: { ...old, path, bytes: Number(old.bytes) },
        });
        hashes.set(old.id, hash);
        byHash.set(hash, old.id);
      } catch {
        if (old.exclusion === "excluded")
          unresolvedExcludedSizes.add(String(old.bytes));
      }
    }
    for (const entry of candidates) {
      if (stop()) break;
      let item = jobs.item(id, entry.document.id)!;
      if (item.registered) {
        if (item.hash) byHash.set(item.hash, item.document.id);
        continue;
      }
      try {
        const doc = item.document,
          hash = await rpc.call<string>("hash", { document: doc });
        if (stop()) break;
        const duplicate = byHash.get(hash);
        if (duplicate && duplicate !== doc.id) {
          jobs.patchItem(id, doc.id, {
            kind: "duplicate",
            hash,
            reason: "동일한 파일 내용이 이미 등록됨",
            error: "",
          });
          continue;
        }
        if (unresolvedExcludedSizes.has(String(doc.bytes))) {
          jobs.patchItem(id, doc.id, {
            kind: "review",
            reason: "제외 원본의 해시를 확인할 수 없어 중복 여부 확인 필요",
          });
          continue;
        }
        await rpc.call("prepare", { document: doc, hash });
        if (stop()) break;
        await importPdfCatalog(db, owner, [doc]);
        const book = (
          await db.query(
            "SELECT b.id,b.version FROM library_documents d JOIN library_books b ON b.owner_id=d.owner_id AND b.id=d.book_id WHERE d.owner_id=$1 AND d.id=$2",
            [owner, doc.id],
          )
        ).rows[0];
        jobs.patchItem(id, doc.id, {
          registered: true,
          bookId: book.id,
          bookVersion: Number(book.version),
          hash,
          error: "",
        });
        byHash.set(hash, doc.id);
      } catch {
        jobs.patchItem(id, item.document.id, {
          error: "기본 등록 실패: 파일 변경·폴더 연결·DB 상태를 확인하세요.",
        });
      }
    }
    // Front/back identification and metadata run before full-body extraction.
    setPhase("enriching");
    for (const entry of jobs.items(id)) {
      if (stop()) break;
      if (!entry.registered || entry.enriched || entry.error) continue;
      try {
        const info = await rpc.call<{
          pageCount: number;
          author: string;
          pages: IdentityPage[];
        }>("identity", { document: entry.document });
        const evidence = extractPdfIdentity(
          {
            id: entry.document.id,
            title: entry.document.title,
            author: info.author,
            signature: `${entry.document.bytes}:${entry.document.mtime_ns}`,
            sha256: entry.hash!,
            pageCount: info.pageCount,
            processingScope: "full",
            status: "ready",
          },
          info.pages,
        );
        const records = await (
            options.metadata ?? ((e) => importMetadataCandidates(jobs, e))
          )(evidence),
          resolution = resolvePdfIdentity(evidence, records);
        jobs.patchItem(id, entry.document.id, {
          records,
          reason: resolution.reason,
          ocrPending: evidence.pendingOcrPages.length > 0,
        });
        if (stop()) break;
        if (resolution.state === "verified" && resolution.record) {
          // Check live source again after the network requests and before applying metadata.
          if (
            (await rpc.call("hash", { document: entry.document })) !==
            entry.hash
          )
            throw Error();
          const version = await applyImportMetadata(
            db,
            owner,
            entry,
            resolution.record,
          );
          jobs.patchItem(id, entry.document.id, {
            reviewed: true,
            bookVersion: version,
          });
        }
        jobs.patchItem(id, entry.document.id, { enriched: true, error: "" });
      } catch {
        jobs.patchItem(id, entry.document.id, {
          error:
            "서지 보완 대기: 인증키·호출 한도·원본을 확인한 뒤 오류 재시도해 주세요.",
        });
      }
    }
    setPhase("indexing");
    for (const entry of jobs.items(id)) {
      if (stop()) break;
      if (!entry.registered || entry.indexed) continue;
      try {
        for (;;) {
          if (stop()) break;
          const result = await rpc.call<{
            status: string;
            page_count: number;
            error?: string;
          }>("index", { document: entry.document });
          if (["error", "locked", "changed", "missing"].includes(result.status))
            throw Error();
          if (result.status !== "indexing" && result.status !== "pending") {
            jobs.patchItem(id, entry.document.id, {
              indexed: true,
              ocrPending: result.status !== "ready",
            });
            break;
          }
        }
      } catch {
        jobs.patchItem(id, entry.document.id, {
          error: "본문 색인 실패: 암호·손상·원본 변경 여부를 확인하세요.",
        });
      }
    }
    jobs.release(id, worker, stop() ? "paused" : "complete");
  } catch {
    jobs.release(
      id,
      worker,
      "failed",
      "작업을 중단했습니다. 폴더·PC 설정을 확인한 뒤 재개해 주세요.",
    );
  } finally {
    clearInterval(heartbeat);
    rpc.close();
  }
}
