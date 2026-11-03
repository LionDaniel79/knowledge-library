import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { testDatabase } from "./helpers/database";
import {
  startDesktopManifest,
  putDesktopItems,
  sealDesktopManifest,
  previewDesktopManifest,
  previewDesktopCleanup,
} from "../src/server/desktop-catalog";
import { applyPdfRetention } from "../src/server/pdf-retention";
import { desktopItemsDigest } from "../src/lib/desktop-catalog-contract";

type Seed = {
  bookId: string;
  documentId: string;
  selected: boolean;
  kind: "book" | "paper" | "periodical" | "pdf_archive" | null;
  material: "book" | "paper" | "periodical" | "review";
  scope: "full" | "metadata_only";
};

it("preserves 36 owner exclusions, holds 37 moved supplements and 3 removed PDFs, retains links and sync state", async () => {
  const fixture = await testDatabase();
  const priorFlag = process.env.LIBRARY_STAGE5_WRITE_ENABLED;
  const owner = "stage5-seventy-six-safety-fixture";
  try {
    const deviceId = randomUUID();
    await fixture.db.query(
      "INSERT INTO library_desktop_tokens(owner_id,id,name,token_hash,expires_at) VALUES($1,$2,'Synthetic QA device',$3,now()+interval '1 day')",
      [owner, deviceId, "a".repeat(64)],
    );
    const cases: Seed[] = [];
    const add = (
      selected: boolean,
      kind: Seed["kind"],
      material: Seed["material"],
      scope: Seed["scope"],
    ) => {
      const row = {
        bookId: randomUUID(),
        documentId: randomUUID(),
        selected,
        kind,
        material,
        scope,
      };
      cases.push(row);
      return row;
    };

    // Exact real-world cohort shapes; every identifier is synthetic.
    const manual = add(true, "book", "book", "full");
    for (let i = 0; i < 31; i++) add(true, "paper", "paper", "metadata_only");
    for (let i = 0; i < 4; i++)
      add(true, "periodical", "periodical", "metadata_only");
    const currentMergedBook = add(true, null, "book", "full");
    const reversible = add(true, "pdf_archive", "book", "full");
    const movedResearch = Array.from({ length: 37 }, () =>
      add(false, null, "review", "metadata_only"),
    );
    const supersededOrDeleted = Array.from({ length: 3 }, () =>
      add(false, null, "book", "full"),
    );
    const historicallyExcluded = add(false, "paper", "paper", "metadata_only");

    for (const [i, row] of cases.entries()) {
      await fixture.db.query(
        "INSERT INTO library_books(id,owner_id,title,author,formats,source_key,source_data) VALUES($1,$2,$3,'QA',ARRAY['pdf'],$4,$5::jsonb)",
        [
          row.bookId,
          owner,
          "Synthetic PDF " + i,
          "qa-stage5-book-" + i,
          JSON.stringify({ app: "Local PDF", testOnly: true }),
        ],
      );
      await fixture.db.query(
        "INSERT INTO library_documents(id,owner_id,book_id,root,path,relative_path,bytes,mtime_ns,processing_scope,material_kind,scope_reason,scope_version) VALUES($1,$2,$3,'qa',$4,$5,1,'1',$6,$7,'','v1')",
        [row.documentId, owner, row.bookId, "fake-" + i + ".pdf", "qa/fake-" + i + ".pdf", row.scope, row.material],
      );
      if (row.kind) {
        await fixture.db.query(
          "INSERT INTO library_book_exclusions(id,owner_id,kind,reason,batch_id,state) VALUES($1,$2,$3,'Existing owner decision',$4,'excluded')",
          [row.bookId, owner, row.kind, randomUUID()],
        );
      }
    }

    // Linked material must survive with its original book IDs unchanged.
    const referenceBook = movedResearch[0];
    const connectedBooks = [referenceBook, manual];
    for (const row of connectedBooks) {
      await fixture.db.query(
        "INSERT INTO library_notes(id,owner_id,book_id,title,content,kind) VALUES($1,$2,$3,'QA note','Preserve this note','note')",
        [randomUUID(), owner, row.bookId],
      );
      await fixture.db.query(
        "INSERT INTO library_cycles(id,owner_id,book_id,status) VALUES($1,$2,$3,'reading')",
        [randomUUID(), owner, row.bookId],
      );
    }
    const [left, right] = [
      referenceBook.bookId,
      currentMergedBook.bookId,
    ].sort();
    await fixture.db.query(
      "INSERT INTO library_book_relations(id,owner_id,left_id,right_id,relation,state,reason,evidence) VALUES($1,$2,$3,$4,'same_edition','accepted','Synthetic link','{}'::jsonb)",
      [randomUUID(), owner, left, right],
    );
    await fixture.db.query(
      "INSERT INTO library_catalog_reviews(id,owner_id,book_id,source_version,book_snapshot,record,fingerprint) VALUES($1,$2,$3,1,'{}'::jsonb,'{}'::jsonb,$4)",
      [randomUUID(), owner, referenceBook.bookId, "c".repeat(64)],
    );
    await fixture.db.query(
      "INSERT INTO library_reference_sources(id,owner_id,source_kind,source_id,source_version,url,provider,title,content_hash,excerpt,edition_match) VALUES($1,$2,'book',$3,'1','https://example.invalid/source','QA','Synthetic source',$4,'','document')",
      [randomUUID(), owner, referenceBook.bookId, "d".repeat(64)],
    );

    // A prior registry entry on a held source must not be marked archived
    // merely because the document moved out of the selected Windows roots.
    await fixture.db.query(
      "INSERT INTO library_pdf_registry(owner_id,document_id,book_id,registration_root,state) VALUES($1,$2,$3,'general','registered'),($1,$4,$5,'general','registered')",
      [
        owner,
        movedResearch[0].documentId,
        movedResearch[0].bookId,
        supersededOrDeleted[0].documentId,
        supersededOrDeleted[0].bookId,
      ],
    );

    const selected = cases.filter((row) => row.selected);
    const start = await startDesktopManifest(
      fixture.db,
      { owner, deviceId },
      {
        operationId: randomUUID(),
        scanComplete: true,
        rootsAvailable: true,
        physicalByRoot: { christian: selected.length, general: 0 },
        expectedDocuments: selected.length,
      },
    );
    const items = selected.map((row) => ({
      legacyDocumentId: row.documentId,
      bookId: row.bookId,
      expectedBookVersion: 1,
      copiesByRoot: { christian: 1, general: 0 },
    }));
    expect(
      (
        await putDesktopItems(
          fixture.db,
          { owner, deviceId },
          start.manifestId,
          { items },
        )
      ).created,
    ).toBe(selected.length);
    const digest = desktopItemsDigest(items);
    await sealDesktopManifest(
      fixture.db,
      { owner, deviceId },
      start.manifestId,
      { itemsDigest: digest },
    );
    const preview = await previewDesktopManifest(
      fixture.db,
      { owner, deviceId },
      start.manifestId,
    );
    expect(preview).toMatchObject({
      selectedDocuments: 38,
      manualExclusions: 1,
      scopeExclusions: 35,
      protectedSelectedBooks: 36,
      restorablePdfArchiveBooks: 1,
      archiveBooks: 41,
      unselectedBooks: 41,
      previouslyExcludedBooks: 1,
      heldUnselectedBooks: 40,
      heldReviewBooks: 37,
      heldOtherBooks: 3,
      automaticallyArchivableBooks: 0,
      canApplySelection: false,
      canDelete: false,
    });
    const cleanup = await previewDesktopCleanup(
      fixture.db,
      { owner, deviceId },
      start.manifestId,
    );
    expect(cleanup).toMatchObject({
      heldUnselectedBooks: 40,
      protectedSelectedBooks: 36,
      backupVerified: false,
      syncVerified: false,
      deleteAuthorized: false,
    });
    expect(Number(cleanup.relatedRecords.notes)).toBe(1);
    expect(Number(cleanup.relatedRecords.cycles)).toBe(1);
    expect(Number(cleanup.relatedRecords.reviews)).toBe(1);
    expect(Number(cleanup.relatedRecords.relations)).toBe(1);
    expect(Number(cleanup.relatedRecords.reference_sources)).toBe(1);

    const fingerprint = async (table: string) =>
      (
        await fixture.db.query(
          `SELECT count(*)::int AS n,md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' ORDER BY t.id::text),'')) AS checksum FROM ${table} t WHERE owner_id=$1`,
          [owner],
        )
      ).rows[0];
    const preservedTables = [
      "library_documents",
      "library_notes",
      "library_cycles",
      "library_book_relations",
      "library_catalog_reviews",
      "library_reference_sources",
    ];
    const before = await Promise.all(preservedTables.map(fingerprint));
    const exclusionsBefore = await fixture.db.query(
      "SELECT id,kind,state,reason,batch_id,version FROM library_book_exclusions WHERE owner_id=$1 ORDER BY id",
      [owner],
    );
    const existingBooks = await fixture.db.query(
      "SELECT id,version FROM library_books WHERE owner_id=$1 ORDER BY id",
      [owner],
    );
    const activeBefore = await fixture.db.query(
      "SELECT count(*)::int AS n FROM library_active_books WHERE owner_id=$1",
      [owner],
    );
    const syncBefore = await fixture.db.query(
      "SELECT count(*)::int AS n FROM library_sync_changes WHERE owner_id=$1",
      [owner],
    );
    delete process.env.LIBRARY_STAGE5_WRITE_ENABLED;
    const payload = {
      itemsDigest: digest,
      expectedArchiveBooks: 41,
      confirmation: "ARCHIVE_UNSELECTED_AND_REGISTER_SELECTED",
    };
    await expect(
      applyPdfRetention(fixture.db, owner, start.manifestId, payload),
    ).rejects.toMatchObject({ status: 403 });

    process.env.LIBRARY_STAGE5_WRITE_ENABLED = "true";
    await expect(
      applyPdfRetention(fixture.db, owner, start.manifestId, {
        ...payload,
        expectedArchiveBooks: 40,
      }),
    ).rejects.toMatchObject({ status: 409 });
    const applied = await applyPdfRetention(
      fixture.db,
      owner,
      start.manifestId,
      payload,
    );
    expect(applied).toMatchObject({
      registeredDocuments: 38,
      archivedBooks: 0,
      restoredBooks: 1,
      protectedSelectedExclusions: 36,
      heldUnselectedBooks: 40,
      previouslyExcludedBooks: 1,
      heldReviewBooks: 37,
      heldOtherBooks: 3,
      automaticallyArchivableBooks: 0,
      preservedPdfFiles: true,
      preservedOcrAndHistory: true,
    });
    // A repeated apply must not generate duplicate history or state changes.
    expect(
      await applyPdfRetention(fixture.db, owner, start.manifestId, payload),
    ).toEqual(applied);

    const after = await Promise.all(preservedTables.map(fingerprint));
    expect(after).toEqual(before);
    expect(
      (
        await fixture.db.query(
          "SELECT count(*)::int AS n FROM library_pdf_registry WHERE owner_id=$1 AND state='registered'",
          [owner],
        )
      ).rows[0].n,
    ).toBe(40);
    const heldRegistered = await fixture.db.query(
      "SELECT document_id,state,manifest_id FROM library_pdf_registry WHERE owner_id=$1 AND document_id=ANY($2::uuid[]) ORDER BY document_id",
      [
        owner,
        [movedResearch[0].documentId, supersededOrDeleted[0].documentId],
      ],
    );
    expect(heldRegistered.rows).toHaveLength(2);
    expect(heldRegistered.rows.every((row) => row.state === "registered" && row.manifest_id === null)).toBe(true);
    expect(
      (
        await fixture.db.query(
          "SELECT count(*)::int AS n FROM library_pdf_registry WHERE owner_id=$1 AND state='archived'",
          [owner],
        )
      ).rows[0].n,
    ).toBe(0);
    const exclusionsAfter = await fixture.db.query(
      "SELECT id,kind,state,reason,batch_id,version FROM library_book_exclusions WHERE owner_id=$1 ORDER BY id",
      [owner],
    );
    const unchangedBefore = exclusionsBefore.rows.filter(
      (row) => row.id !== reversible.bookId,
    );
    const unchangedAfter = exclusionsAfter.rows.filter(
      (row) => row.id !== reversible.bookId,
    );
    expect(unchangedAfter).toEqual(unchangedBefore);
    expect(
      exclusionsAfter.rows.find((row) => row.id === historicallyExcluded.bookId),
    ).toMatchObject({ kind: "paper", state: "excluded" });
    expect(
      exclusionsAfter.rows.find((row) => row.id === reversible.bookId),
    ).toMatchObject({
      kind: "pdf_archive",
      state: "restored",
    });
    const currentBooks = await fixture.db.query(
      "SELECT id,version FROM library_books WHERE owner_id=$1 ORDER BY id",
      [owner],
    );
    expect(
      currentBooks.rows.filter((row) => row.id !== reversible.bookId),
    ).toEqual(existingBooks.rows.filter((row) => row.id !== reversible.bookId));
    expect(
      currentBooks.rows.find((row) => row.id === reversible.bookId)?.version,
    ).toBe(2);
    const activeAfter = await fixture.db.query(
      "SELECT count(*)::int AS n FROM library_active_books WHERE owner_id=$1",
      [owner],
    );
    expect(activeAfter.rows[0].n).toBe(activeBefore.rows[0].n + 1);
    const syncAfter = await fixture.db.query(
      "SELECT count(*)::int AS n FROM library_sync_changes WHERE owner_id=$1",
      [owner],
    );
    expect(syncAfter.rows[0].n).toBeGreaterThan(syncBefore.rows[0].n);

    // In particular, the 37 research supplements, 2 merged NASA sources and
    // owner-deleted MLK source are not hidden or deleted by an automated scan.
    for (const row of [...movedResearch, ...supersededOrDeleted]) {
      expect(
        exclusionsAfter.rows.find((exclusion) => exclusion.id === row.bookId),
      ).toBeUndefined();
    }
    expect(
      (
        await fixture.db.query(
          "SELECT count(*)::int AS n FROM library_documents WHERE owner_id=$1",
          [owner],
        )
      ).rows[0].n,
    ).toBe(cases.length);
    expect(
      (
        await fixture.db.query(
          "SELECT state FROM library_book_exclusions WHERE owner_id=$1 AND id=$2",
          [owner, manual.bookId],
        )
      ).rows[0].state,
    ).toBe("excluded");
  } finally {
    if (priorFlag === undefined)
      delete process.env.LIBRARY_STAGE5_WRITE_ENABLED;
    else process.env.LIBRARY_STAGE5_WRITE_ENABLED = priorFlag;
    await fixture.pg.close();
  }
});
