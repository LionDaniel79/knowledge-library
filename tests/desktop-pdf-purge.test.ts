import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { testDatabase } from "./helpers/database";
import {
  startDesktopManifest,
  putDesktopItems,
  sealDesktopManifest,
} from "../src/server/desktop-catalog";
import { desktopItemsDigest } from "../src/lib/desktop-catalog-contract";
import {
  previewDesktopPdfPurge,
  applyDesktopPdfPurge,
} from "../src/server/desktop-pdf-purge";
const routeContext = vi.hoisted(() => ({ owner: "", db: null as any }));
vi.mock("@/server/auth", () => ({
  requireOwner: async () => {
    if (!routeContext.owner)
      throw new (await import("../src/server/library-store")).LibraryError(
        401,
        "로그인이 필요합니다.",
      );
    return routeContext.owner;
  },
}));
vi.mock("@/server/db", () => ({
  database: {
    query: (s: string, p: unknown[]) => routeContext.db.query(s, p),
    transaction: (fn: unknown) => routeContext.db.transaction(fn),
  },
}));
import { POST as previewRoute } from "../src/app/api/desktop/catalog/cleanup/preview/route";
import { POST as applyRoute } from "../src/app/api/desktop/catalog/cleanup/apply-batch/route";

let f: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  f = await testDatabase();
  routeContext.db = f.db;
  vi.stubEnv("LIBRARY_DESKTOP_PURGE_ENABLED", "true");
});
afterAll(async () => {
  await f.pg.close();
  vi.unstubAllEnvs();
});
async function book(owner: string, path = "논문/synthetic.pdf") {
  const id = randomUUID(),
    documentId = randomUUID();
  await f.db.query(
    "INSERT INTO library_books(id,owner_id,title,formats,source_key,source_data) VALUES($1,$2,'Synthetic PDF',ARRAY['pdf'],$3,$4::jsonb)",
    [id, owner, id, JSON.stringify({ app: "Local PDF", recordId: documentId })],
  );
  await f.db.query(
    "INSERT INTO library_documents(id,owner_id,book_id,root,path,relative_path,bytes,mtime_ns,processing_scope,material_kind) VALUES($1,$2,$3,'synthetic',$4,$5,1,'1','full','paper')",
    [documentId, owner, id, documentId, path],
  );
  return { id, documentId };
}
async function fixture() {
  const owner = randomUUID(),
    deviceId = randomUUID();
  await f.db.query(
    "INSERT INTO library_desktop_tokens(owner_id,id,name,token_hash,expires_at) VALUES($1,$2,'Synthetic',$3,now()+interval '1 day')",
    [owner, deviceId, randomUUID().replaceAll("-", "").repeat(2)],
  );
  const selected = await book(owner, "기독도서/synthetic.pdf"),
    candidate = await book(owner);
  const who = { owner, deviceId };
  const { manifestId } = await startDesktopManifest(f.db, who, {
    operationId: randomUUID(),
    scanComplete: true,
    rootsAvailable: true,
    physicalByRoot: { christian: 1, general: 0 },
    expectedDocuments: 1,
  });
  const item = {
    legacyDocumentId: selected.documentId,
    bookId: selected.id,
    expectedBookVersion: 1,
    copiesByRoot: { christian: 1, general: 0 },
  };
  await putDesktopItems(f.db, who, manifestId, { items: [item] });
  await sealDesktopManifest(f.db, who, manifestId, {
    itemsDigest: desktopItemsDigest([item]),
  });
  return { owner, deviceId, manifestId, selected, candidate };
}
async function approval(x: Awaited<ReturnType<typeof fixture>>) {
  const p = await previewDesktopPdfPurge(f.db, x.owner, {
    manifestId: x.manifestId,
  });
  const backupAttestationId = randomUUID();
  await f.db.query(
    "INSERT INTO library_desktop_purge_backups(owner_id,id,manifest_id,plan_hash,source_revision,backup_sha256,restore_report_sha256,verified_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now(),now()+interval '1 hour')",
    [
      x.owner,
      backupAttestationId,
      x.manifestId,
      p.planHash,
      p.sourceRevision,
      "a".repeat(64),
      "b".repeat(64),
    ],
  );
  return {
    requestId: randomUUID(),
    manifestId: x.manifestId,
    itemsDigest: p.itemsDigest,
    planHash: p.planHash,
    reviewed: p.allowed,
    backupAttestationId,
    confirmation: "PERMANENTLY DELETE WEB PDF METADATA" as const,
  };
}
it("previews exact unreferenced outside-root metadata without writing or exposing original paths", async () => {
  const x = await fixture();
  const before = (
    await f.db.query(
      "SELECT revision FROM library_sync_heads WHERE owner_id=$1",
      [x.owner],
    )
  ).rows[0];
  const p = await previewDesktopPdfPurge(f.db, x.owner, {
    manifestId: x.manifestId,
  });
  expect(p.allowed).toEqual([
    {
      bookId: x.candidate.id,
      expectedBookVersion: 1,
      documentIds: [x.candidate.documentId],
    },
  ]);
  expect(p.protectedSelectedBooks).toBe(1);
  expect(JSON.stringify(p)).not.toContain("synthetic.pdf");
  expect(
    (
      await f.db.query(
        "SELECT revision FROM library_sync_heads WHERE owner_id=$1",
        [x.owner],
      )
    ).rows[0],
  ).toEqual(before);
  expect(
    (await previewDesktopPdfPurge(f.db, x.owner, { manifestId: x.manifestId }))
      .planHash,
  ).toBe(p.planHash);
});
it("purges metadata transactionally, retains identity blocks, emits tombstones, and replays the same request", async () => {
  const x = await fixture(),
    resourceId = randomUUID();
  await f.db.query(
    "INSERT INTO library_desktop_resources(owner_id,device_id,resource_id,book_id,document_id,locations) VALUES($1,$2,$3,$4,$5,'[]')",
    [x.owner, x.deviceId, resourceId, x.candidate.id, x.candidate.documentId],
  );
  await f.db.query(
    "INSERT INTO library_pdf_registry(owner_id,document_id,book_id,registration_root) VALUES($1,$2,$3,'general')",
    [x.owner, x.candidate.documentId, x.candidate.id],
  );
  await f.db.query(
    "INSERT INTO library_cover_locations(owner_id,book_id,storage_kind,object_key,verification_status) VALUES($1,$2,'external','https://example.invalid/synthetic.png','verified')",
    [x.owner, x.candidate.id],
  );
  const p = await approval(x),
    result = await applyDesktopPdfPurge(f.db, x.owner, p);
  expect(result.deletedBookIds).toEqual([x.candidate.id]);
  expect(await applyDesktopPdfPurge(f.db, x.owner, p)).toEqual(result);
  expect(
    (
      await f.db.query("SELECT id FROM library_books WHERE owner_id=$1", [
        x.owner,
      ])
    ).rows.map((r) => r.id),
  ).toEqual([x.selected.id]);
  expect(
    (
      await f.db.query(
        "SELECT state,locations FROM library_desktop_resources WHERE owner_id=$1",
        [x.owner],
      )
    ).rows[0],
  ).toEqual({ state: "blocked", locations: [] });
  expect(
    (
      await f.db.query(
        "SELECT document_id,book_id FROM library_desktop_document_blocks WHERE owner_id=$1",
        [x.owner],
      )
    ).rows,
  ).toEqual([{ document_id: x.candidate.documentId, book_id: x.candidate.id }]);
  expect(
    (
      await f.db.query(
        "SELECT document_id FROM library_pdf_registry WHERE owner_id=$1",
        [x.owner],
      )
    ).rows,
  ).toEqual([]);
  expect(
    (
      await f.db.query(
        "SELECT book_id FROM library_cover_locations WHERE owner_id=$1",
        [x.owner],
      )
    ).rows,
  ).toEqual([]);
  for (const entity of ["library_books", "library_documents"])
    expect(
      (
        await f.db.query(
          "SELECT deleted FROM library_sync_row_versions WHERE owner_id=$1 AND entity=$2 AND record_key=$3",
          [
            x.owner,
            entity,
            JSON.stringify([
              entity === "library_books"
                ? x.candidate.id
                : x.candidate.documentId,
            ]),
          ],
        )
      ).rows[0]?.deleted,
    ).toBe(true);
  await expect(
    applyDesktopPdfPurge(f.db, x.owner, { ...p, planHash: "f".repeat(64) }),
  ).rejects.toMatchObject({ status: 409 });
});
it("holds personal and indirect JSON references, mixed media, manual exclusions, selected-root omissions and ambiguous mappings", async () => {
  const x = await fixture();
  await f.db.query(
    "INSERT INTO library_whiteboards(owner_id,id,data) VALUES($1,$2,$3::jsonb)",
    [
      x.owner,
      randomUUID(),
      JSON.stringify({ nested: [{ source: x.candidate.documentId }] }),
    ],
  );
  const mixed = await book(x.owner),
    manual = await book(x.owner),
    missing = await book(x.owner, "일반도서/omitted.pdf"),
    unmapped = randomUUID();
  await f.db.query(
    "UPDATE library_books SET formats=ARRAY['paper','pdf'] WHERE owner_id=$1 AND id=$2",
    [x.owner, mixed.id],
  );
  await f.db.query(
    "INSERT INTO library_book_exclusions(owner_id,id,kind,reason,batch_id) VALUES($1,$2,'book','manual',$3)",
    [x.owner, manual.id, randomUUID()],
  );
  await f.db.query(
    "INSERT INTO library_books(id,owner_id,title,formats,source_data) VALUES($1,$2,'Unmapped',ARRAY['pdf'],'{\"app\":\"Local PDF\"}')",
    [unmapped, x.owner],
  );
  const p = await previewDesktopPdfPurge(f.db, x.owner, {
    manifestId: x.manifestId,
  });
  expect(p.allowed).toEqual([]);
  const reasons = (id: string) => p.held.find((r) => r.bookId === id)?.reasons;
  expect(reasons(x.candidate.id)).toContain("reference:library_whiteboards");
  expect(reasons(mixed.id)).toContain("mixed_formats");
  expect(reasons(manual.id)).toContain("manual_exclusion");
  expect(reasons(missing.id)).toContain("selected_root_or_unknown_location");
  expect(reasons(unmapped)).toContain("missing_document_mapping");
});
it("rejects references added after preview, versions, wrong exact sets, missing attestation and disabled gate", async () => {
  const x = await fixture(),
    p = await approval(x);
  await expect(
    applyDesktopPdfPurge(f.db, x.owner, { ...p, reviewed: [] }),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    applyDesktopPdfPurge(f.db, x.owner, {
      ...p,
      backupAttestationId: randomUUID(),
    }),
  ).rejects.toMatchObject({ status: 409 });
  vi.stubEnv("LIBRARY_DESKTOP_PURGE_ENABLED", "false");
  await expect(applyDesktopPdfPurge(f.db, x.owner, p)).rejects.toMatchObject({
    status: 403,
  });
  vi.stubEnv("LIBRARY_DESKTOP_PURGE_ENABLED", "true");
  await f.db.query(
    "INSERT INTO library_notes(id,owner_id,book_id,title,content,kind) VALUES($1,$2,$3,'Keep','Keep','note')",
    [randomUUID(), x.owner, x.candidate.id],
  );
  await expect(applyDesktopPdfPurge(f.db, x.owner, p)).rejects.toMatchObject({
    status: 409,
  });
  expect(
    (
      await f.db.query(
        "SELECT count(*)::int AS n FROM library_books WHERE owner_id=$1",
        [x.owner],
      )
    ).rows[0].n,
  ).toBe(2);
  expect(
    (
      await f.db.query(
        "SELECT count(*)::int AS n FROM library_desktop_document_blocks WHERE owner_id=$1",
        [x.owner],
      )
    ).rows[0].n,
  ).toBe(0);
});
it("rejects old, newer/incomplete manifests, tampered digest, cross-owner and stale selected versions", async () => {
  const x = await fixture();
  await expect(
    previewDesktopPdfPurge(f.db, randomUUID(), { manifestId: x.manifestId }),
  ).rejects.toMatchObject({ status: 404 });
  await f.db.query(
    "UPDATE library_books SET version=2 WHERE owner_id=$1 AND id=$2",
    [x.owner, x.selected.id],
  );
  await expect(
    previewDesktopPdfPurge(f.db, x.owner, { manifestId: x.manifestId }),
  ).rejects.toMatchObject({ status: 409 });
  await f.db.query(
    "UPDATE library_books SET version=1 WHERE owner_id=$1 AND id=$2",
    [x.owner, x.selected.id],
  );
  await f.db.query(
    "UPDATE library_desktop_manifests SET sealed_at=now()-interval '2 days' WHERE owner_id=$1",
    [x.owner],
  );
  await expect(
    previewDesktopPdfPurge(f.db, x.owner, { manifestId: x.manifestId }),
  ).rejects.toMatchObject({ status: 409 });
  await f.db.query(
    "UPDATE library_desktop_manifests SET sealed_at=now(),items_digest=$2 WHERE owner_id=$1",
    [x.owner, "f".repeat(64)],
  );
  await expect(
    previewDesktopPdfPurge(f.db, x.owner, { manifestId: x.manifestId }),
  ).rejects.toMatchObject({ status: 409 });
});
it("rolls back deletion and all identity/tombstone writes when an unexpected dependency fails", async () => {
  const x = await fixture(),
    p = await approval(x);
  await f.db.query(
    "CREATE TABLE synthetic_unknown_dependency(owner_id text, book_id uuid, FOREIGN KEY(owner_id,book_id) REFERENCES library_books(owner_id,id))",
  );
  try {
    await expect(applyDesktopPdfPurge(f.db, x.owner, p)).rejects.toMatchObject({
      status: 409,
    });
    expect(
      (
        await f.db.query("SELECT id FROM library_books WHERE id=$1", [
          x.candidate.id,
        ])
      ).rows.length,
    ).toBe(1);
    expect(
      (
        await f.db.query(
          "SELECT document_id FROM library_desktop_document_blocks WHERE owner_id=$1",
          [x.owner],
        )
      ).rows,
    ).toEqual([]);
  } finally {
    await f.db.query("DROP TABLE synthetic_unknown_dependency");
  }
});
it("keeps compact ID receipts while holding receipts with bibliographic payloads", async () => {
  const x = await fixture();
  await f.db.query(
    "INSERT INTO library_operations(owner_id,request_id,fingerprint,result) VALUES($1,$2,'synthetic',$3::jsonb)",
    [x.owner, randomUUID(), JSON.stringify({ id: x.candidate.id, version: 1 })],
  );
  expect(
    (await previewDesktopPdfPurge(f.db, x.owner, { manifestId: x.manifestId }))
      .allowed,
  ).toHaveLength(1);
  await f.db.query(
    "INSERT INTO library_operations(owner_id,request_id,fingerprint,result) VALUES($1,$2,'synthetic',$3::jsonb)",
    [
      x.owner,
      randomUUID(),
      JSON.stringify({ id: x.candidate.id, title: "Keep personal snapshot" }),
    ],
  );
  expect(
    (await previewDesktopPdfPurge(f.db, x.owner, { manifestId: x.manifestId }))
      .held[0].reasons,
  ).toContain("reference:library_operations");
});
it("rolls back identity blocks, deletes and tombstones when a delete trigger fails", async () => {
  const x = await fixture(),
    p = await approval(x);
  await f.db.query(
    "CREATE FUNCTION synthetic_purge_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'synthetic rollback'; END$$",
  );
  await f.db.query(
    "CREATE TRIGGER synthetic_purge_failure BEFORE DELETE ON library_books FOR EACH ROW EXECUTE FUNCTION synthetic_purge_failure()",
  );
  try {
    await expect(applyDesktopPdfPurge(f.db, x.owner, p)).rejects.toThrow(
      "synthetic rollback",
    );
    expect(
      (
        await f.db.query("SELECT id FROM library_documents WHERE id=$1", [
          x.candidate.documentId,
        ])
      ).rows.length,
    ).toBe(1);
    expect(
      (
        await f.db.query(
          "SELECT document_id FROM library_desktop_document_blocks WHERE owner_id=$1",
          [x.owner],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await f.db.query(
          "SELECT deleted FROM library_sync_row_versions WHERE owner_id=$1 AND entity='library_documents' AND record_key=$2",
          [x.owner, JSON.stringify([x.candidate.documentId])],
        )
      ).rows[0].deleted,
    ).toBe(false);
  } finally {
    await f.db.query("DROP TRIGGER synthetic_purge_failure ON library_books");
    await f.db.query("DROP FUNCTION synthetic_purge_failure()");
  }
});
it("holds a document whose active desktop identity still claims an approved selected root", async () => {
  const x = await fixture();
  await f.db.query(
    "INSERT INTO library_desktop_resources(owner_id,device_id,resource_id,book_id,document_id,locations) VALUES($1,$2,$3,$4,$5,$6::jsonb)",
    [
      x.owner,
      x.deviceId,
      randomUUID(),
      x.candidate.id,
      x.candidate.documentId,
      JSON.stringify([{ rootKey: "general", relativePath: "selected.pdf" }]),
    ],
  );
  const p = await previewDesktopPdfPurge(f.db, x.owner, {
    manifestId: x.manifestId,
  });
  expect(p.allowed).toEqual([]);
  expect(p.held[0].reasons).toContain("selected_root_or_unknown_location");
});
it("rejects a newer collecting manifest and any mutation of generated mapping after review", async () => {
  const x = await fixture(),
    p = await approval(x);
  await f.db.query(
    "INSERT INTO library_pdf_registry(owner_id,document_id,book_id,registration_root) VALUES($1,$2,$3,'christian')",
    [x.owner, x.candidate.documentId, x.candidate.id],
  );
  await expect(applyDesktopPdfPurge(f.db, x.owner, p)).rejects.toMatchObject({
    status: 409,
  });
  await startDesktopManifest(
    f.db,
    { owner: x.owner, deviceId: x.deviceId },
    {
      operationId: randomUUID(),
      scanComplete: true,
      rootsAvailable: true,
      physicalByRoot: { christian: 1, general: 0 },
      expectedDocuments: 1,
    },
  );
  await expect(
    previewDesktopPdfPurge(f.db, x.owner, { manifestId: x.manifestId }),
  ).rejects.toMatchObject({ status: 409 });
});
it("rejects false backup attestations: wrong owner, plan, revision, expired, old and consumed proofs", async () => {
  const x = await fixture();
  for (const mutation of [
    "plan_hash='ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'",
    "source_revision=source_revision+1",
    "verified_at=now()-interval '2 days'",
    "expires_at=now()-interval '1 minute',verified_at=now()-interval '2 minutes'",
    "consumed_request_id=gen_random_uuid()",
    "owner_id='other-owner'",
  ]) {
    const p = await approval(x);
    await f.db.query(
      `UPDATE library_desktop_purge_backups SET ${mutation} WHERE id=$1`,
      [p.backupAttestationId],
    );
    await expect(applyDesktopPdfPurge(f.db, x.owner, p)).rejects.toMatchObject({
      status: 409,
    });
  }
  expect(
    (
      await f.db.query(
        "SELECT document_id FROM library_desktop_document_blocks WHERE owner_id=$1",
        [x.owner],
      )
    ).rows,
  ).toEqual([]);
});
it("requires owner authentication for preview and owner plus same-origin confirmation for apply", async () => {
  const x = await fixture(),
    p = await approval(x);
  vi.stubEnv("APP_ORIGIN", "https://synthetic.invalid");
  const req = (body: unknown, origin = "https://synthetic.invalid") =>
    new Request(
      "https://synthetic.invalid/api/desktop/catalog/cleanup/preview",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
          authorization: "Bearer device-token-is-insufficient",
        },
        body: JSON.stringify(body),
      },
    );
  routeContext.owner = "";
  expect((await previewRoute(req({ manifestId: x.manifestId }))).status).toBe(
    401,
  );
  expect((await applyRoute(req(p))).status).toBe(401);
  routeContext.owner = x.owner;
  const result = await previewRoute(req({ manifestId: x.manifestId }));
  expect(result.status).toBe(200);
  expect(result.headers.get("cache-control")).toContain("no-store");
  expect((await applyRoute(req(p, "https://other.invalid"))).status).toBe(403);
  expect((await applyRoute(req({ ...p, confirmation: "yes" }))).status).toBe(
    400,
  );
  expect((await applyRoute(req(p))).status).toBe(200);
  routeContext.owner = "";
});
it("allows the restricted runtime to consume proof and purge, but never to manufacture backup evidence", async () => {
  const x = await fixture(),
    p = await approval(x);
  await f.db.query("CREATE ROLE library_web_runtime");
  try {
    await f.db.query("GRANT USAGE ON SCHEMA public TO library_web_runtime");
    await f.db.query(
      "GRANT SELECT ON ALL TABLES IN SCHEMA public TO library_web_runtime",
    );
    await f.db.query(
      "GRANT INSERT,UPDATE ON library_operations,library_desktop_resources TO library_web_runtime",
    );
    await f.db.query(
      "GRANT EXECUTE ON FUNCTION library_sync_lock(text) TO library_web_runtime",
    );
    await f.pg.exec(await readFile("db/038_desktop_pdf_purge.sql", "utf8"));
    await f.db.query("SET ROLE library_web_runtime");
    await expect(
      f.db.query(
        "INSERT INTO library_desktop_purge_backups(owner_id,id,manifest_id,plan_hash,source_revision,backup_sha256,restore_report_sha256,verified_at,expires_at) VALUES($1,$2,$3,$4,0,$4,$4,now(),now()+interval '1 hour')",
        [x.owner, randomUUID(), x.manifestId, "c".repeat(64)],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    expect(
      (await applyDesktopPdfPurge(f.db, x.owner, p)).deletedBookIds,
    ).toEqual([x.candidate.id]);
  } finally {
    await f.db.query("RESET ROLE");
    await f.db.query("DROP OWNED BY library_web_runtime");
    await f.db.query("DROP ROLE library_web_runtime");
  }
});
