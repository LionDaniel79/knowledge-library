import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { testDatabase } from "./helpers/database";
import {
  startDesktopManifest,
  putDesktopItems,
  sealDesktopManifest,
  previewDesktopManifest,
} from "../src/server/desktop-catalog";
import { desktopItemsDigest } from "../src/lib/desktop-catalog-contract";
import { applyPdfRetention } from "../src/server/pdf-retention";

it("holds unselected PDFs and reversibly restores only a previously approved pdf_archive", async () => {
  const fixture = await testDatabase();
  const originalFlag = process.env.LIBRARY_STAGE5_WRITE_ENABLED;
  try {
    const owner = "stage4-pdf-retention";
    const deviceId = randomUUID();
    const firstBook = randomUUID();
    const secondBook = randomUUID();
    const firstDoc = randomUUID();
    const secondDoc = randomUUID();
    const who = { owner, deviceId };
    await fixture.db.query(
      "INSERT INTO library_desktop_tokens(owner_id,id,name,token_hash,expires_at) VALUES($1,$2,'Study PC',$3,now()+interval '1 day')",
      [owner, deviceId, "d".repeat(64)],
    );
    for (const [bookId, documentId, key] of [
      [firstBook, firstDoc, "first"],
      [secondBook, secondDoc, "second"],
    ]) {
      await fixture.db.query(
        "INSERT INTO library_books(id,owner_id,title,author,formats,source_key,source_data) VALUES($1,$2,$3,'author',ARRAY['pdf'],$4,$5::jsonb)",
        [
          bookId,
          owner,
          key,
          key,
          JSON.stringify({
            app: "Local PDF",
            recordId: documentId,
            libraryId: "test",
            raw: {},
          }),
        ],
      );
      await fixture.db.query(
        "INSERT INTO library_documents(id,owner_id,book_id,root,path,relative_path,bytes,mtime_ns,processing_scope,material_kind,scope_reason,scope_version) VALUES($1,$2,$3,'test',$4,$5,1,'1','full','book','','v1')",
        [documentId, owner, bookId, key + ".pdf", "기독도서/" + key + ".pdf"],
      );
    }
    const seal = async (
      bookId: string,
      documentId: string,
      version: number,
    ) => {
      const begin = await startDesktopManifest(fixture.db, who, {
        operationId: randomUUID(),
        scanComplete: true,
        rootsAvailable: true,
        physicalByRoot: { christian: 1, general: 0 },
        expectedDocuments: 1,
      });
      const item = {
        legacyDocumentId: documentId,
        bookId,
        expectedBookVersion: version,
        copiesByRoot: { christian: 1, general: 0 },
      };
      await putDesktopItems(fixture.db, who, begin.manifestId, {
        items: [item],
      });
      const itemsDigest = desktopItemsDigest([item]);
      await sealDesktopManifest(fixture.db, who, begin.manifestId, {
        itemsDigest,
      });
      return { id: begin.manifestId, itemsDigest };
    };
    const first = await seal(firstBook, firstDoc, 1);
    expect(
      await previewDesktopManifest(fixture.db, who, first.id),
    ).toMatchObject({
      selectedDocuments: 1,
      archiveBooks: 1,
      archiveDocuments: 1,
      heldUnselectedBooks: 1,
      automaticallyArchivableBooks: 0,
      canDelete: false,
    });
    const input = {
      itemsDigest: first.itemsDigest,
      expectedArchiveBooks: 1,
      confirmation: "ARCHIVE_UNSELECTED_AND_REGISTER_SELECTED",
    };
    delete process.env.LIBRARY_STAGE5_WRITE_ENABLED;
    await expect(
      applyPdfRetention(fixture.db, owner, first.id, input),
    ).rejects.toMatchObject({ status: 403 });
    process.env.LIBRARY_STAGE5_WRITE_ENABLED = "true";
    const applied = await applyPdfRetention(fixture.db, owner, first.id, input);
    expect(applied).toMatchObject({
      registeredDocuments: 1,
      archivedBooks: 0,
      restoredBooks: 0,
      heldUnselectedBooks: 1,
      preservedPdfFiles: true,
    });
    expect(await applyPdfRetention(fixture.db, owner, first.id, input)).toEqual(
      applied,
    );
    // A missing/unselected source PDF is not an archive instruction.
    expect(
      (
        await fixture.db.query(
          "SELECT count(*)::int AS n FROM library_book_exclusions WHERE owner_id=$1 AND id=$2",
          [owner, secondBook],
        )
      ).rows[0].n,
    ).toBe(0);
    // An explicitly preexisting reversible archive can still be restored.
    await fixture.db.query(
      "INSERT INTO library_book_exclusions(id,owner_id,kind,reason,batch_id,state) VALUES($1,$2,'pdf_archive','Previously reviewed decision',$3,'excluded')",
      [secondBook, owner, randomUUID()],
    );
    expect(
      (
        await fixture.db.query(
          "SELECT state FROM library_pdf_registry WHERE owner_id=$1 AND document_id=$2",
          [owner, firstDoc],
        )
      ).rows[0].state,
    ).toBe("registered");

    const second = await seal(secondBook, secondDoc, 1);
    const restored = await applyPdfRetention(fixture.db, owner, second.id, {
      itemsDigest: second.itemsDigest,
      expectedArchiveBooks: 1,
      confirmation: input.confirmation,
    });
    expect(restored).toMatchObject({
      registeredDocuments: 1,
      archivedBooks: 0,
      restoredBooks: 1,
      heldUnselectedBooks: 1,
    });
    expect(
      (
        await fixture.db.query(
          "SELECT state FROM library_book_exclusions WHERE owner_id=$1 AND id=$2",
          [owner, secondBook],
        )
      ).rows[0].state,
    ).toBe("restored");
    expect(
      (
        await fixture.db.query(
          "SELECT state FROM library_pdf_registry WHERE owner_id=$1 AND document_id=$2",
          [owner, firstDoc],
        )
      ).rows[0].state,
    ).toBe("registered");
    expect(
      (
        await fixture.db.query(
          "SELECT count(*)::int AS n FROM library_documents WHERE owner_id=$1 AND id=ANY($2::uuid[])",
          [owner, [firstDoc, secondDoc]],
        )
      ).rows[0].n,
    ).toBe(2);
  } finally {
    if (originalFlag === undefined)
      delete process.env.LIBRARY_STAGE5_WRITE_ENABLED;
    else process.env.LIBRARY_STAGE5_WRITE_ENABLED = originalFlag;
    await fixture.pg.close();
  }
});
