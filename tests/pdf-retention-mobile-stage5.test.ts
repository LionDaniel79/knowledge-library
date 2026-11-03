import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { testDatabase } from "./helpers/database";
import { sqlSyncTransport } from "./helpers/sync-transport";
import { createMemoryReplica } from "../src/client/replica/memory-storage";
import { createReplicaRepository } from "../src/client/replica/repository";
import { createReplicaCoordinator } from "../src/client/replica/coordinator";
import { bootstrapReplica } from "../src/client/replica/bootstrap";
import { queueReplicaCommand } from "../src/client/replica/outbox";
import {
  startDesktopManifest,
  putDesktopItems,
  sealDesktopManifest,
  previewDesktopManifest,
} from "../src/server/desktop-catalog";
import { desktopItemsDigest } from "../src/lib/desktop-catalog-contract";
import { applyPdfRetention } from "../src/server/pdf-retention";

it("keeps offline phone and second device consistent across a protected desktop manifest and a reversible PDF restore", async () => {
  const f = await testDatabase();
  const owner = "stage5-mobile-pdf-reconnect-fixture";
  const deviceId = randomUUID();
  const flagBefore = process.env.LIBRARY_STAGE5_WRITE_ENABLED;
  const phone = createMemoryReplica(owner);
  const tablet = createMemoryReplica(owner);
  const pr = createReplicaRepository(phone);
  const tr = createReplicaRepository(tablet);
  const transport = sqlSyncTransport(f.db, owner);
  const ids = {
    manual: randomUUID(),
    scope: randomUUID(),
    archived: randomUUID(),
    active: randomUUID(),
    research: randomUUID(),
    mergedSource: randomUUID(),
  };
  const documents = Object.fromEntries(
    Object.keys(ids).map((name) => [name, randomUUID()]),
  ) as Record<keyof typeof ids, string>;
  try {
    await f.db.query(
      "INSERT INTO library_desktop_tokens(owner_id,id,name,token_hash,expires_at) VALUES($1,$2,'Mobile integration fixture',$3,now()+interval '1 day')",
      [owner, deviceId, "e".repeat(64)],
    );
    for (const [name, id] of Object.entries(ids)) {
      await f.db.query(
        "INSERT INTO library_books(id,owner_id,title,author,formats,source_key,source_data) VALUES($1,$2,$3,'QA',ARRAY['pdf'],$4,$5::jsonb)",
        [id, owner, "Fixture " + name, "stage5-mobile-" + name, JSON.stringify({ app: "Local PDF" })],
      );
      await f.db.query(
        "INSERT INTO library_documents(id,owner_id,book_id,root,path,relative_path,bytes,mtime_ns,material_kind,processing_scope,scope_reason,scope_version) VALUES($1,$2,$3,'qa',$4,$5,100,'1',$6,$7,'','v1')",
        [documents[name as keyof typeof ids], owner, id, name + ".pdf", "qa/" + name + ".pdf",
          name === "research" ? "review" : "book",
          name === "research" ? "metadata_only" : "full"],
      );
    }
    for (const [name, kind] of [["manual", "book"], ["scope", "paper"], ["archived", "pdf_archive"]] as const)
      await f.db.query(
        "INSERT INTO library_book_exclusions(id,owner_id,kind,reason,batch_id,state) VALUES($1,$2,$3,'Existing owner decision',$4,'excluded')",
        [ids[name], owner, kind, randomUUID()],
      );

    const seedNoteIds = [randomUUID(), randomUUID()];
    for (const [index, bookId] of [ids.archived, ids.manual].entries()) {
      await f.db.query(
        "INSERT INTO library_notes(id,owner_id,book_id,title,content,kind) VALUES($1,$2,$3,'Preserved note','Existing memo','note')",
        [seedNoteIds[index], owner, bookId],
      );
      await f.db.query(
        "INSERT INTO library_cycles(id,owner_id,book_id,status,started_on,current_page) VALUES($1,$2,$3,'reading','2026-11-01',12)",
        [randomUUID(), owner, bookId],
      );
    }
    const left = [ids.archived, ids.active].sort()[0];
    const right = [ids.archived, ids.active].sort()[1];
    const relationId = randomUUID();
    await f.db.query(
      "INSERT INTO library_book_relations(id,owner_id,left_id,right_id,relation,state,reason,evidence) VALUES($1,$2,$3,$4,'same_edition','accepted','Fixture link','{}'::jsonb)",
      [relationId, owner, left, right],
    );
    await f.db.query(
      "INSERT INTO library_pdf_registry(owner_id,document_id,book_id,registration_root,state) VALUES($1,$2,$3,'general','registered')",
      [owner, documents.research, ids.research],
    );

    const who = { owner, deviceId };
    const selectedNames = ["manual", "scope", "archived", "active"] as const;
    const started = await startDesktopManifest(f.db, who, {
      operationId: randomUUID(),
      scanComplete: true,
      rootsAvailable: true,
      physicalByRoot: { christian: 4, general: 0 },
      expectedDocuments: 4,
    });
    const items = selectedNames.map((name) => ({
      legacyDocumentId: documents[name],
      bookId: ids[name],
      expectedBookVersion: 1,
      copiesByRoot: { christian: 1, general: 0 },
    }));
    await putDesktopItems(f.db, who, started.manifestId, { items });
    const digest = desktopItemsDigest(items);
    await sealDesktopManifest(f.db, who, started.manifestId, { itemsDigest: digest });
    const preview = await previewDesktopManifest(f.db, who, started.manifestId);
    expect(preview).toMatchObject({
      manualExclusions: 1, scopeExclusions: 1,
      restorablePdfArchiveBooks: 1, heldUnselectedBooks: 2,
      heldReviewBooks: 1, heldOtherBooks: 1, automaticallyArchivableBooks: 0,
      canApplySelection: false, canDelete: false,
    });

    await bootstrapReplica({ owner, storage: phone, transport });
    await bootstrapReplica({ owner, storage: tablet, transport });
    const localBookIds = async (repo: typeof pr) =>
      (await repo.books({ limit: 50 })).items.map((b) => b.id);
    const beforePhone = await localBookIds(pr);
    const beforeTablet = await localBookIds(tr);
    for (const before of [beforePhone, beforeTablet]) {
      expect(before).not.toContain(ids.manual);
      expect(before).not.toContain(ids.scope);
      expect(before).not.toContain(ids.archived);
      expect(before).toEqual(expect.arrayContaining([ids.active, ids.research, ids.mergedSource]));
    }
    expect((await pr.reading({ book: ids.archived })).total).toBe(0);
    expect((await tr.reading({ book: ids.archived })).total).toBe(0);

    const commandId = randomUUID();
    const queued = await queueReplicaCommand({
      storage: phone,
      repository: pr,
      path: "/api/library",
      body: {
        requestId: commandId,
        type: "addNote",
        payload: {
          title: "Offline phone thought",
          content: "Keep this text after reconnect",
          kind: "thought",
          bookId: ids.active,
        },
      },
    });
    expect(await phone.listOutbox()).toHaveLength(1);
    expect((await pr.notes({ book: ids.active })).items).toHaveLength(1);
    const beforeDocs = (await f.db.query(
      "SELECT id,book_id,path,bytes,mtime_ns FROM library_documents WHERE owner_id=$1 ORDER BY id", [owner],
    )).rows;
    const beforeRelation = (await f.db.query(
      "SELECT * FROM library_book_relations WHERE owner_id=$1", [owner],
    )).rows;
    const beforeNotes = (await f.db.query(
      "SELECT id,book_id,content FROM library_notes WHERE owner_id=$1 ORDER BY id", [owner],
    )).rows;
    const beforeCycles = (await f.db.query(
      "SELECT id,book_id,status,current_page FROM library_cycles WHERE owner_id=$1 ORDER BY id", [owner],
    )).rows;

    process.env.LIBRARY_STAGE5_WRITE_ENABLED = "true"; // isolated PGlite only
    const applyArgs = {
      itemsDigest: digest,
      expectedArchiveBooks: 2,
      confirmation: "ARCHIVE_UNSELECTED_AND_REGISTER_SELECTED",
    };
    const applied = await applyPdfRetention(f.db, owner, started.manifestId, applyArgs);
    expect(applied).toMatchObject({
      registeredDocuments: 4, restoredBooks: 1, archivedBooks: 0,
      protectedSelectedExclusions: 2, heldUnselectedBooks: 2,
      automaticallyArchivableBooks: 0,
    });
    expect(await applyPdfRetention(f.db, owner, started.manifestId, applyArgs))
      .toEqual(applied);
    expect((await f.db.query(
      "SELECT id,book_id,path,bytes,mtime_ns FROM library_documents WHERE owner_id=$1 ORDER BY id", [owner],
    )).rows).toEqual(beforeDocs);
    expect((await f.db.query(
      "SELECT * FROM library_book_relations WHERE owner_id=$1", [owner],
    )).rows).toEqual(beforeRelation);
    expect((await f.db.query(
      "SELECT id,book_id,content FROM library_notes WHERE owner_id=$1 ORDER BY id", [owner],
    )).rows).toEqual(beforeNotes);
    expect((await f.db.query(
      "SELECT id,book_id,status,current_page FROM library_cycles WHERE owner_id=$1 ORDER BY id", [owner],
    )).rows).toEqual(beforeCycles);

    const remoteChanges = (await f.db.query(
      "SELECT entity,record_key,deleted FROM library_sync_row_versions WHERE owner_id=$1 AND entity IN ('library_books','library_book_exclusions') AND record_key IN ($2,$3)",
      [owner, JSON.stringify([ids.archived]), JSON.stringify([ids.manual])],
    )).rows;
    expect(remoteChanges.some((r) => r.entity === "library_book_exclusions" &&
      r.record_key === JSON.stringify([ids.archived]) && r.deleted === false)).toBe(true);
    expect(remoteChanges.some((r) => r.entity === "library_books" &&
      r.record_key === JSON.stringify([ids.archived]) && r.deleted === false)).toBe(true);

    // Interrupted reconnection: the pending local memo must remain in the outbox.
    const changes = transport.changes;
    let disconnected = true;
    transport.changes = async (...args) => {
      if (disconnected) {
        disconnected = false;
        throw Error("simulated network disconnect before replica pull");
      }
      return changes(...args);
    };
    const phoneCoordinator = createReplicaCoordinator({ owner, storage: phone, transport });
    await expect(phoneCoordinator.syncReplica({ reason: "online" }))
      .rejects.toThrow("simulated network disconnect");
    expect(await phone.listOutbox()).toHaveLength(1);
    expect((await pr.books({ limit: 50 })).items.map((b) => b.id)).not.toContain(ids.archived);
    await phoneCoordinator.syncReplica({ reason: "reconnected" });
    const tabletCoordinator = createReplicaCoordinator({ owner, storage: tablet, transport });
    await tabletCoordinator.syncReplica({ reason: "online" });
    await phoneCoordinator.syncReplica({ reason: "repeat" });
    await tabletCoordinator.syncReplica({ reason: "repeat" });

    for (const repo of [pr, tr]) {
      const current = await localBookIds(repo);
      expect(current.filter((x) => x === ids.archived)).toHaveLength(1);
      expect(current).toContain(ids.archived);
      expect(current).not.toContain(ids.manual);
      expect(current).not.toContain(ids.scope);
      expect(current).toContain(ids.research);
      expect(current).toContain(ids.mergedSource);
      expect((await repo.reading({ book: ids.archived })).total).toBe(1);
      expect((await repo.notes({ book: ids.archived })).items.map((n: { id: string }) => n.id))
        .toContain(seedNoteIds[0]);
      expect((await repo.notes({ book: ids.active })).items.map((n: { id: string }) => n.id))
        .toContain(queued.id);
      expect((await repo.books({ limit: 50 })).items.filter((b) => b.id === ids.archived))
        .toHaveLength(1);
    }
    expect(await phone.listOutbox()).toHaveLength(0);
    expect(await tablet.listOutbox()).toHaveLength(0);
    expect((await f.db.query(
      "SELECT count(*)::int AS n FROM library_notes WHERE owner_id=$1 AND id=$2",
      [owner, queued.id],
    )).rows[0].n).toBe(1);
    expect((await f.db.query(
      "SELECT kind,state FROM library_book_exclusions WHERE owner_id=$1 AND id=$2",
      [owner, ids.archived],
    )).rows[0]).toMatchObject({ kind: "pdf_archive", state: "restored" });
    for (const id of [ids.manual, ids.scope])
      expect((await f.db.query(
        "SELECT state FROM library_book_exclusions WHERE owner_id=$1 AND id=$2",
        [owner, id],
      )).rows[0].state).toBe("excluded");
    expect((await f.db.query(
      "SELECT document_id,state FROM library_pdf_registry WHERE owner_id=$1 AND document_id=$2",
      [owner, documents.research],
    )).rows).toEqual([{ document_id: documents.research, state: "registered" }]);
    const laterSync = await f.db.query(
      "SELECT count(*)::int AS n FROM library_notes WHERE owner_id=$1 AND title='Offline phone thought'",
      [owner],
    );
    expect(laterSync.rows[0].n).toBe(1);
  } finally {
    if (flagBefore === undefined) delete process.env.LIBRARY_STAGE5_WRITE_ENABLED;
    else process.env.LIBRARY_STAGE5_WRITE_ENABLED = flagBefore;
    pr.close();
    tr.close();
    await f.pg.close();
  }
});
