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
import { createBookExclusionStore } from "../src/server/book-exclusions";
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
it("keeps the reviewed plan identical across database session time zones", async () => {
  const x = await fixture();
  try {
    await f.db.query("SET TIME ZONE 'UTC'");
    const first = await previewDesktopPdfPurge(f.db, x.owner, {
      manifestId: x.manifestId,
    });
    await f.db.query("SET TIME ZONE 'Asia/Seoul'");
    const restored = await previewDesktopPdfPurge(f.db, x.owner, {
      manifestId: x.manifestId,
    });
    expect(restored.allowed).toEqual(first.allowed);
    expect(restored.planHash).toBe(first.planHash);
  } finally {
    await f.db.query("SET TIME ZONE 'UTC'");
  }
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
async function migrationFixture() {
  const x = await fixture();
  await f.db.query(
    "UPDATE library_documents SET relative_path='일반도서/old.pdf',processing_scope='metadata_only',material_kind='periodical' WHERE owner_id=$1 AND id=$2",
    [x.owner, x.candidate.documentId],
  );
  const imported = (
    await f.db.query(
      "SELECT to_jsonb(b) AS value FROM library_books b WHERE id=$1",
      [x.candidate.id],
    )
  ).rows[0].value;
  const importRevision = randomUUID(),
    enrichRevision = randomUUID();
  await f.db.query(
    "INSERT INTO library_revisions(id,owner_id,entity_id,action,after_data) VALUES($1,$2,$3,'importPdf',$4::jsonb)",
    [importRevision, x.owner, x.candidate.id, JSON.stringify(imported)],
  );
  await f.db.query(
    "UPDATE library_books SET title='Generated enrichment',version=2,tags=ARRAY['Synthetic tag'] WHERE id=$1",
    [x.candidate.id],
  );
  // Tags are part of import, never part of enrichment's allowed mutation set.
  imported.tags = ["Synthetic tag"];
  await f.db.query(
    "UPDATE library_revisions SET after_data=$2::jsonb WHERE id=$1",
    [importRevision, JSON.stringify(imported)],
  );
  const enriched = (
    await f.db.query(
      "SELECT to_jsonb(b) AS value FROM library_books b WHERE id=$1",
      [x.candidate.id],
    )
  ).rows[0].value;
  await f.db.query(
    "INSERT INTO library_revisions(id,owner_id,entity_id,action,before_data,after_data) VALUES($1,$2,$3,'enrichBibliography',$4::jsonb,$5::jsonb)",
    [
      enrichRevision,
      x.owner,
      x.candidate.id,
      JSON.stringify(imported),
      JSON.stringify(enriched),
    ],
  );
  await createBookExclusionStore(f.db).exclude(x.owner, {
    requestId: randomUUID(),
    items: [{ id: x.candidate.id, expectedVersion: 2, kind: "periodical" }],
  });
  const topicId = randomUUID(),
    membershipId = randomUUID();
  await f.db.query(
    "INSERT INTO library_topics(id,owner_id,name,confirmed) VALUES($1,$2,'Synthetic tag',false)",
    [topicId, x.owner],
  );
  const member = (
    await f.db.query(
      "INSERT INTO library_topic_memberships(id,owner_id,topic_id,source_kind,source_id,source_version,status,method,evidence) VALUES($1,$2,$3,'book',$4,'1','suggested','existing-tags-v1','[{\"matchedTag\":\"Synthetic tag\",\"coverage\":\"metadata\"}]') RETURNING *",
      [membershipId, x.owner, topicId, x.candidate.id],
    )
  ).rows[0];
  await f.db.query(
    "INSERT INTO library_revisions(id,owner_id,entity_id,action,after_data) VALUES($1,$2,$1,'proposeTopicMembership',$3::jsonb)",
    [membershipId, x.owner, JSON.stringify(member)],
  );
  return { ...x, membershipId, topicId, importRevision, enrichRevision };
}
async function scopeWitness(x: Awaited<ReturnType<typeof migrationFixture>>) {
  const p = await previewDesktopPdfPurge(f.db, x.owner, {
    manifestId: x.manifestId,
  });
  const id = randomUUID();
  await f.db.query(
    "INSERT INTO library_desktop_purge_scope_evidence(owner_id,id,manifest_id,items_digest,source_revision,scan_id,scan_completed,roots_available,inventory_complete,inventory_files,inventory_documents,christian_files,general_files,outside_files,unmapped_files,documents,verified_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,true,true,true,2,2,1,0,1,0,$7::jsonb,now(),now()+interval '1 hour')",
    [
      x.owner,
      id,
      x.manifestId,
      p.itemsDigest,
      p.sourceRevision,
      randomUUID(),
      JSON.stringify([
        {
          bookId: x.candidate.id,
          documentId: x.candidate.documentId,
          expectedBookVersion: 2,
          outsideCopies: 1,
        },
      ]),
    ],
  );
  return id;
}
it("keeps strict defaults but allows explicitly witnessed outside-root migration metadata with exact generated removal targets", async () => {
  const x = await migrationFixture();
  expect(
    (await previewDesktopPdfPurge(f.db, x.owner, { manifestId: x.manifestId }))
      .allowed,
  ).toEqual([]);
  const scopeEvidenceId = await scopeWitness(x);
  const p = await previewDesktopPdfPurge(f.db, x.owner, {
    manifestId: x.manifestId,
    scopeEvidenceId,
  });
  expect(p.allowed).toEqual([
    {
      bookId: x.candidate.id,
      expectedBookVersion: 2,
      documentIds: [x.candidate.documentId],
    },
  ]);
  expect(p.generated.membershipIds).toEqual([x.membershipId]);
  expect(p.generated.exclusionBookIds).toEqual([x.candidate.id]);
  expect(p.generated.revisionIds).toContain(x.importRevision);
  const backupAttestationId = randomUUID();
  await f.db.query(
    "INSERT INTO library_desktop_purge_backups(owner_id,id,manifest_id,plan_hash,source_revision,backup_sha256,restore_report_sha256,verified_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$6,now(),now()+interval '1 hour')",
    [
      x.owner,
      backupAttestationId,
      x.manifestId,
      p.planHash,
      p.sourceRevision,
      "e".repeat(64),
    ],
  );
  const apply = {
    requestId: randomUUID(),
    manifestId: x.manifestId,
    scopeEvidenceId,
    itemsDigest: p.itemsDigest,
    planHash: p.planHash,
    reviewed: p.allowed,
    reviewedGenerated: p.generated,
    backupAttestationId,
    confirmation: "PERMANENTLY DELETE WEB PDF METADATA",
  };
  await expect(
    applyDesktopPdfPurge(f.db, x.owner, {
      ...apply,
      reviewedGenerated: { ...p.generated, revisionIds: [] },
    }),
  ).rejects.toMatchObject({ status: 409 });
  const missingGenerated = { ...apply };
  delete (missingGenerated as any).reviewedGenerated;
  await expect(
    applyDesktopPdfPurge(f.db, x.owner, missingGenerated),
  ).rejects.toMatchObject({ status: 409 });
  expect(
    (await applyDesktopPdfPurge(f.db, x.owner, apply)).deletedBookIds,
  ).toEqual([x.candidate.id]);
  for (const [entity, id] of [
    ["library_topic_memberships", x.membershipId],
    ["library_revisions", x.importRevision],
    ["library_book_exclusions", x.candidate.id],
  ])
    expect(
      (
        await f.db.query(
          "SELECT deleted FROM library_sync_row_versions WHERE owner_id=$1 AND entity=$2 AND record_key=$3",
          [x.owner, entity, JSON.stringify([id])],
        )
      ).rows[0].deleted,
    ).toBe(true);
  expect(
    (await f.db.query("SELECT id FROM library_topics WHERE id=$1", [x.topicId]))
      .rows,
  ).toHaveLength(1);
  expect(
    (
      await f.db.query(
        "SELECT document_id FROM library_desktop_document_blocks WHERE owner_id=$1",
        [x.owner],
      )
    ).rows,
  ).toHaveLength(1);
});
it("holds invalid, stale, foreign, false, incomplete and wrong-version inventory witnesses", async () => {
  const x = await migrationFixture();
  for (const mutation of [
    "verified_at=now()-interval '2 days'",
    "inventory_complete=false",
    "roots_available=false",
    "scan_completed=false",
    "inventory_files=3",
    "unmapped_files=1",
    "source_revision=source_revision+1",
    "owner_id='another-owner'",
    "documents='[]'::jsonb",
  ]) {
    const id = await scopeWitness(x);
    await f.db.query(
      `UPDATE library_desktop_purge_scope_evidence SET ${mutation} WHERE id=$1`,
      [id],
    );
    const p = await previewDesktopPdfPurge(f.db, x.owner, {
      manifestId: x.manifestId,
      scopeEvidenceId: id,
    });
    expect(p.allowed).toEqual([]);
    expect(p.held[0].reasons).toContain("scope_evidence_invalid");
  }
  const id = await scopeWitness(x);
  await f.db.query(
    "UPDATE library_desktop_purge_scope_evidence SET documents=jsonb_set(documents,'{0,expectedBookVersion}','1') WHERE id=$1",
    [id],
  );
  expect(
    (
      await previewDesktopPdfPurge(f.db, x.owner, {
        manifestId: x.manifestId,
        scopeEvidenceId: id,
      })
    ).allowed,
  ).toEqual([]);
});
it("holds manual revisions, accepted/rejected memberships and altered bulk exclusion history despite an outside witness", async () => {
  for (const change of [
    "edit",
    "accepted",
    "rejected",
    "manual-method",
    "altered-exclusion",
  ]) {
    const x = await migrationFixture();
    if (change === "edit")
      await f.db.query(
        "INSERT INTO library_revisions(id,owner_id,entity_id,action,after_data) VALUES($1,$2,$3,'editBook','{}')",
        [randomUUID(), x.owner, x.candidate.id],
      );
    else if (change === "altered-exclusion")
      await f.db.query(
        "UPDATE library_book_exclusions SET reason='manual reason' WHERE owner_id=$1 AND id=$2",
        [x.owner, x.candidate.id],
      );
    else if (change === "manual-method")
      await f.db.query(
        "UPDATE library_topic_memberships SET method='manual' WHERE id=$1",
        [x.membershipId],
      );
    else
      await f.db.query(
        "UPDATE library_topic_memberships SET status=$2 WHERE id=$1",
        [x.membershipId, change],
      );
    const id = await scopeWitness(x),
      p = await previewDesktopPdfPurge(f.db, x.owner, {
        manifestId: x.manifestId,
        scopeEvidenceId: id,
      });
    expect(p.allowed).toEqual([]);
    expect(p.generated.revisionIds).toEqual([]);
  }
});
it("protects user references to generated membership identities and unknown FKs into generated tables", async () => {
  const x = await migrationFixture();
  await f.db.query(
    "INSERT INTO library_whiteboards(owner_id,id,data) VALUES($1,$2,$3::jsonb)",
    [x.owner, randomUUID(), JSON.stringify({ membership: x.membershipId })],
  );
  const id = await scopeWitness(x),
    p = await previewDesktopPdfPurge(f.db, x.owner, {
      manifestId: x.manifestId,
      scopeEvidenceId: id,
    });
  expect(p.allowed).toEqual([]);
  expect(p.held[0].reasons).toContain("reference:library_whiteboards");
  await f.db.query(
    "CREATE TABLE synthetic_generated_reference(owner_id text,member_id uuid,FOREIGN KEY(member_id) REFERENCES library_topic_memberships(id) ON DELETE CASCADE)",
  );
  try {
    await expect(
      previewDesktopPdfPurge(f.db, x.owner, {
        manifestId: x.manifestId,
        scopeEvidenceId: id,
      }),
    ).rejects.toMatchObject({ status: 409 });
  } finally {
    await f.db.query("DROP TABLE synthetic_generated_reference");
  }
});
it("requires operator-only evidence creation and holds generated rows whose stored snapshots differ", async () => {
  const x = await migrationFixture();
  await f.db.query(
    "UPDATE library_revisions SET after_data=jsonb_set(after_data,'{status}','\"accepted\"') WHERE id=$1",
    [x.membershipId],
  );
  const id = await scopeWitness(x),
    p = await previewDesktopPdfPurge(f.db, x.owner, {
      manifestId: x.manifestId,
      scopeEvidenceId: id,
    });
  expect(p.allowed).toEqual([]);
  expect(p.held[0].reasons).toContain("reference:library_revisions");
  await f.db.query("CREATE ROLE library_web_runtime");
  try {
    await f.pg.exec(
      await readFile("db/040_desktop_pdf_purge_scope_evidence.sql", "utf8"),
    );
    await f.db.query("GRANT USAGE ON SCHEMA public TO library_web_runtime");
    await f.db.query("SET ROLE library_web_runtime");
    expect(
      (
        await f.db.query(
          "SELECT id FROM library_desktop_purge_scope_evidence WHERE id=$1",
          [id],
        )
      ).rows,
    ).toHaveLength(1);
    await expect(
      f.db.query(
        "UPDATE library_desktop_purge_scope_evidence SET inventory_complete=false WHERE id=$1",
        [id],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      f.db.query(
        "INSERT INTO library_desktop_purge_scope_evidence SELECT * FROM library_desktop_purge_scope_evidence WHERE id=$1",
        [id],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      f.db.query(
        "DELETE FROM library_desktop_purge_scope_evidence WHERE id=$1",
        [id],
      ),
    ).rejects.toMatchObject({ code: "42501" });
  } finally {
    await f.db.query("RESET ROLE");
    await f.db.query("DROP OWNED BY library_web_runtime");
    await f.db.query("DROP ROLE library_web_runtime");
  }
});
it("rolls back generated-row removal and tombstones if the final book deletion fails", async () => {
  const x = await migrationFixture(),
    scopeEvidenceId = await scopeWitness(x);
  const p = await previewDesktopPdfPurge(f.db, x.owner, {
    manifestId: x.manifestId,
    scopeEvidenceId,
  });
  const backupAttestationId = randomUUID();
  await f.db.query(
    "INSERT INTO library_desktop_purge_backups(owner_id,id,manifest_id,plan_hash,source_revision,backup_sha256,restore_report_sha256,verified_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$6,now(),now()+interval '1 hour')",
    [
      x.owner,
      backupAttestationId,
      x.manifestId,
      p.planHash,
      p.sourceRevision,
      "e".repeat(64),
    ],
  );
  await f.db.query(
    "CREATE FUNCTION synthetic_migration_purge_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'migration rollback'; END$$",
  );
  await f.db.query(
    "CREATE TRIGGER synthetic_migration_purge_failure BEFORE DELETE ON library_books FOR EACH ROW EXECUTE FUNCTION synthetic_migration_purge_failure()",
  );
  try {
    await expect(
      applyDesktopPdfPurge(f.db, x.owner, {
        requestId: randomUUID(),
        manifestId: x.manifestId,
        scopeEvidenceId,
        itemsDigest: p.itemsDigest,
        planHash: p.planHash,
        reviewed: p.allowed,
        reviewedGenerated: p.generated,
        backupAttestationId,
        confirmation: "PERMANENTLY DELETE WEB PDF METADATA",
      }),
    ).rejects.toThrow("migration rollback");
    expect(
      (
        await f.db.query(
          "SELECT id FROM library_topic_memberships WHERE id=$1",
          [x.membershipId],
        )
      ).rows,
    ).toHaveLength(1);
    expect(
      (
        await f.db.query("SELECT id FROM library_revisions WHERE id=$1", [
          x.importRevision,
        ])
      ).rows,
    ).toHaveLength(1);
    expect(
      (
        await f.db.query(
          "SELECT id FROM library_book_exclusions WHERE owner_id=$1 AND id=$2",
          [x.owner, x.candidate.id],
        )
      ).rows,
    ).toHaveLength(1);
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
          "SELECT deleted FROM library_sync_row_versions WHERE owner_id=$1 AND entity='library_topic_memberships' AND record_key=$2",
          [x.owner, JSON.stringify([x.membershipId])],
        )
      ).rows[0].deleted,
    ).toBe(false);
  } finally {
    await f.db.query(
      "DROP TRIGGER synthetic_migration_purge_failure ON library_books",
    );
    await f.db.query("DROP FUNCTION synthetic_migration_purge_failure()");
  }
});
it("recognizes only the exact legacy enrichment before projection while preserving full-snapshot and manual-history holds", async () => {
  const keys = [
    "id",
    "isbn",
    "tags",
    "title",
    "author",
    "version",
    "category",
    "cover_url",
    "publisher",
    "enrichment",
    "source_data",
    "total_pages",
    "classification",
  ];
  for (const variation of [
    "exact",
    "missing-key",
    "extra-key",
    "changed-tags",
    "changed-record",
    "wrong-owner",
    "manual-action",
    "projected-import",
  ]) {
    const x = await migrationFixture();
    const old = (
      await f.db.query(
        "SELECT before_data,after_data FROM library_revisions WHERE id=$1",
        [x.enrichRevision],
      )
    ).rows[0];
    const before = Object.fromEntries(keys.map((k) => [k, old.before_data[k]]));
    if (variation === "missing-key") delete before.classification;
    if (variation === "extra-key") before.unrecognized = "must hold";
    if (variation === "changed-tags") before.tags = ["different tag"];
    if (variation === "changed-record")
      before.source_data = { ...before.source_data, recordId: randomUUID() };
    const after = { ...old.after_data };
    if (variation === "wrong-owner") after.owner_id = "other-owner";
    await f.db.query(
      "UPDATE library_revisions SET before_data=$2::jsonb,after_data=$3::jsonb,action=$4 WHERE id=$1",
      [
        x.enrichRevision,
        JSON.stringify(before),
        JSON.stringify(after),
        variation === "manual-action" ? "editBook" : "enrichBibliography",
      ],
    );
    if (variation === "projected-import")
      await f.db.query(
        "UPDATE library_revisions SET after_data=$2::jsonb WHERE id=$1",
        [x.importRevision, JSON.stringify(before)],
      );
    const scopeEvidenceId = await scopeWitness(x),
      p = await previewDesktopPdfPurge(f.db, x.owner, {
        manifestId: x.manifestId,
        scopeEvidenceId,
      });
    if (variation === "exact") {
      expect(p.allowed.map((b) => b.bookId)).toEqual([x.candidate.id]);
      expect(p.generated.revisionIds).toContain(x.enrichRevision);
    } else {
      expect(p.allowed).toEqual([]);
      expect(p.held[0].reasons).toContain("reference:library_revisions");
    }
  }
});
