import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { testDatabase } from "./helpers/database";
import {
  archiveUnselectedPdfBooks,
  registerSelectedPdfBooks,
} from "../src/server/desktop-transition";
import {
  putDesktopItems,
  sealDesktopManifest,
  startDesktopManifest,
} from "../src/server/desktop-catalog";
import { desktopItemsDigest } from "../src/lib/desktop-catalog-contract";

it("archives unselected PDFs reversibly, restores selected IDs, and never deletes user records", async () => {
  const fixture = await testDatabase();
  const priorGate = process.env.LIBRARY_STAGE5_WRITE_ENABLED;
  try {
    const owner = "pdf-transition-owner";
    const deviceId = randomUUID();
    const selectedBook = randomUUID(),
      otherBook = randomUUID();
    const selectedDoc = randomUUID(),
      otherDoc = randomUUID();
    await fixture.db.query(
      "INSERT INTO library_desktop_tokens(owner_id,id,name,token_hash,expires_at) VALUES($1,$2,'Stage4 test',$3,now()+interval '1 day')",
      [owner, deviceId, "b".repeat(64)],
    );
    for (const [book, doc, path] of [
      [selectedBook, selectedDoc, "christian/selected.pdf"],
      [otherBook, otherDoc, "general/other.pdf"],
    ]) {
      await fixture.db.query(
        "INSERT INTO library_books(id,owner_id,title,author,formats,source_key,source_data) VALUES($1,$2,$3,'',ARRAY['pdf'],$4,$5::jsonb)",
        [
          book,
          owner,
          path,
          path,
          JSON.stringify({
            app: "Local PDF",
            libraryId: "desktop",
            recordId: doc,
            raw: {},
          }),
        ],
      );
      await fixture.db.query(
        "INSERT INTO library_documents(id,owner_id,book_id,root,path,relative_path,bytes,mtime_ns,processing_scope,material_kind,scope_reason,scope_version) VALUES($1,$2,$3,'desktop',$4,$5,1,'1','full','book','','v1')",
        [doc, owner, book, path, path],
      );
    }
    const who = { owner, deviceId };
    async function manifestFor(
      documentId: string,
      bookId: string,
      version: number,
    ) {
      const op = randomUUID();
      const started = await startDesktopManifest(fixture.db, who, {
        operationId: op,
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
      await putDesktopItems(fixture.db, who, started.manifestId, {
        items: [item],
      });
      await sealDesktopManifest(fixture.db, who, started.manifestId, {
        itemsDigest: desktopItemsDigest([item]),
      });
      return started.manifestId;
    }
    const first = await manifestFor(selectedDoc, selectedBook, 1);
    process.env.LIBRARY_STAGE5_WRITE_ENABLED = "false";
    await expect(
      archiveUnselectedPdfBooks(fixture.db, owner, {
        manifestId: first,
        requestId: randomUUID(),
        confirmation: "ARCHIVE_UNSELECTED_PDFS",
        items: [{ bookId: otherBook, expectedBookVersion: 1 }],
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      registerSelectedPdfBooks(fixture.db, owner, first, {
        requestId: randomUUID(),
        confirmation: "REGISTER_SELECTED_PDFS",
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      (
        await fixture.db.query(
          "SELECT count(*)::int AS n FROM library_book_exclusions WHERE owner_id=$1",
          [owner],
        )
      ).rows[0].n,
    ).toBe(0);

    process.env.LIBRARY_STAGE5_WRITE_ENABLED = "true";
    await expect(
      archiveUnselectedPdfBooks(fixture.db, owner, {
        manifestId: first,
        requestId: randomUUID(),
        confirmation: "ARCHIVE_UNSELECTED_PDFS",
        items: [{ bookId: selectedBook, expectedBookVersion: 1 }],
      }),
    ).rejects.toMatchObject({ status: 409 });

    const archive = {
      manifestId: first,
      requestId: randomUUID(),
      confirmation: "ARCHIVE_UNSELECTED_PDFS",
      items: [{ bookId: otherBook, expectedBookVersion: 1 }],
    };
    const archived = await archiveUnselectedPdfBooks(
      fixture.db,
      owner,
      archive,
    );
    expect(archived).toMatchObject({ archivedBooks: 1, permanentlyDeleted: 0 });
    expect(await archiveUnselectedPdfBooks(fixture.db, owner, archive)).toEqual(
      archived,
    );
    expect(
      (
        await fixture.db.query(
          "SELECT state FROM library_book_exclusions WHERE owner_id=$1 AND id=$2",
          [owner, otherBook],
        )
      ).rows[0].state,
    ).toBe("excluded");

    const register = {
      requestId: randomUUID(),
      confirmation: "REGISTER_SELECTED_PDFS",
    };
    const active = await registerSelectedPdfBooks(
      fixture.db,
      owner,
      first,
      register,
    );
    expect(active).toMatchObject({
      registeredDocuments: 1,
      restoredBooks: 0,
      permanentlyDeleted: 0,
    });
    expect(
      await registerSelectedPdfBooks(fixture.db, owner, first, register),
    ).toEqual(active);

    const second = await manifestFor(otherDoc, otherBook, 2);
    const restored = await registerSelectedPdfBooks(fixture.db, owner, second, {
      requestId: randomUUID(),
      confirmation: "REGISTER_SELECTED_PDFS",
    });
    expect(restored).toMatchObject({
      registeredDocuments: 1,
      restoredBooks: 1,
      permanentlyDeleted: 0,
    });
    const state = (
      await fixture.db.query(
        "SELECT state FROM library_book_exclusions WHERE owner_id=$1 AND id=$2",
        [owner, otherBook],
      )
    ).rows[0];
    expect(state.state).toBe("restored");
    expect(
      (
        await fixture.db.query(
          "SELECT version FROM library_books WHERE owner_id=$1 AND id=$2",
          [owner, otherBook],
        )
      ).rows[0].version,
    ).toBe(3);
    expect(
      (
        await fixture.db.query(
          "SELECT count(*)::int AS n FROM library_documents WHERE owner_id=$1",
          [owner],
        )
      ).rows[0].n,
    ).toBe(2);
    expect(
      (
        await fixture.db.query(
          "SELECT count(*)::int AS n FROM library_books WHERE owner_id=$1",
          [owner],
        )
      ).rows[0].n,
    ).toBe(2);
    expect(
      (
        await fixture.db.query(
          "SELECT count(*)::int AS n FROM library_pdf_registry WHERE owner_id=$1",
          [owner],
        )
      ).rows[0].n,
    ).toBe(2);
  } finally {
    if (priorGate === undefined)
      delete process.env.LIBRARY_STAGE5_WRITE_ENABLED;
    else process.env.LIBRARY_STAGE5_WRITE_ENABLED = priorGate;
    await fixture.pg.close();
  }
});
