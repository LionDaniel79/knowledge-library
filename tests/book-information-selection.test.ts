import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import {
  createCurationStore,
  readCurationDetails,
} from "../src/server/curation-store";
import {
  editBookInformation,
  selectBookInformation,
} from "../src/server/book-information-selection";
import { displayedBookInformation } from "../src/lib/book-detail-information";
import { informationValueKey } from "../src/lib/unified-book-information";
it("edits a printed table of contents without dropping its original source or pages", async () => {
  const f = await testDatabase();
  try {
    const id = randomUUID();
    const toc = {
      method: "printed_toc_excerpt",
      documentId: randomUUID(),
      signature: "file-signature",
      pageCount: 100,
      pages: [{ page: 8, method: "text", textHash: "a".repeat(64) }],
      text: "Chapter A",
      truncated: false,
    };
    await f.db.query(
      "INSERT INTO library_books(id,owner_id,title,formats,enrichment) VALUES($1,'owner','Original',ARRAY['pdf'],$2)",
      [id, JSON.stringify({ auto_toc: toc })],
    );
    const result = await editBookInformation(f.db, "owner", {
      action: "editBookInformation",
      bookId: id,
      expectedVersion: 1,
      changes: { toc: "Chapter A corrected" },
    });
    expect(result.enrichment.auto_toc).toEqual({
      ...toc,
      editedText: "Chapter A corrected",
    });
  } finally {
    await f.pg.close();
  }
});
it("saves final information, protects it and preserves automatic history and other records", async () => {
  const f = await testDatabase();
  try {
    const id = randomUUID();
    const enrichment = {
      auto_description: "Saved introduction",
      auto_toc: ["Existing chapter"],
      autoBibliography: {
        fields: ["author", "description", "toc"],
        status: "automatic",
        afterValues: {
          author: "Saved author",
          description: "Saved introduction",
          toc: ["Existing chapter"],
        },
      },
      informationSelections: {
        description: {
          itemId: "automatic",
          valueKey: informationValueKey("description", "Saved introduction"),
        },
      },
    };
    await f.db.query(
      "INSERT INTO library_books(id,owner_id,title,author,formats,enrichment) VALUES($1,'owner','Original','Saved author',ARRAY['paper'],$2)",
      [id, JSON.stringify(enrichment)],
    );
    const command = {
      action: "editBookInformation",
      bookId: id,
      expectedVersion: 1,
      changes: { description: "Updated introduction", toc: "" },
    };
    await expect(
      editBookInformation(f.db, "other", command),
    ).rejects.toMatchObject({ status: 404 });
    const result = await editBookInformation(f.db, "owner", command);
    expect(result.version).toBe(2);
    expect(result.enrichment.autoBibliography).toMatchObject({
      status: "kept",
      pendingFields: [],
      afterValues: enrichment.autoBibliography.afterValues,
    });
    expect(result.enrichment.autoBibliographyLocks).toEqual(
      expect.arrayContaining(["author", "description", "toc"]),
    );
    expect(
      displayedBookInformation(result.enrichment, [
        { id: "old", kind: "toc", value: ["Stale chapter"], state: "active" },
      ]),
    ).toEqual({ description: "Updated introduction" });
    expect(
      (
        await f.db.query("SELECT title,author FROM library_books WHERE id=$1", [
          id,
        ])
      ).rows[0],
    ).toEqual({ title: "Original", author: "Saved author" });
    expect(
      (
        await f.db.query(
          "SELECT action FROM library_revisions WHERE entity_id=$1",
          [id],
        )
      ).rows[0].action,
    ).toBe("editBookInformation");
    await expect(
      editBookInformation(f.db, "owner", command),
    ).rejects.toMatchObject({ status: 409 });
  } finally {
    await f.pg.close();
  }
});
it("stores only display preference, checks owner/version/value and leaves sources unchanged", async () => {
  const f = await testDatabase();
  try {
    const id = randomUUID();
    await f.db.query(
      "INSERT INTO library_books(id,owner_id,title,formats) VALUES($1,'owner','Original',ARRAY['paper'])",
      [id],
    );
    const request = {
      bookId: id,
      expectedVersion: 1,
      field: "description",
      itemId: "automatic",
      valueKey: informationValueKey("description", "Intro"),
    };
    await f.db.query("UPDATE library_books SET enrichment=$2 WHERE id=$1", [
      id,
      JSON.stringify({
        autoBibliography: {
          fields: ["description"],
          status: "automatic",
          afterValues: { description: "Intro" },
        },
      }),
    ]);
    await expect(
      selectBookInformation(f.db, "another", request),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      selectBookInformation(f.db, "owner", {
        ...request,
        valueKey: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ status: 409 });
    const result = await selectBookInformation(f.db, "owner", request);
    expect(result.version).toBe(2);
    const b = (
      await f.db.query(
        "SELECT title,enrichment FROM library_books WHERE id=$1",
        [id],
      )
    ).rows[0];
    expect(b.title).toBe("Original");
    expect(b.enrichment.informationSelections.description.itemId).toBe(
      "automatic",
    );
    expect(b.enrichment.autoBibliography.afterValues.description).toBe("Intro");
    await expect(
      selectBookInformation(f.db, "owner", request),
    ).rejects.toMatchObject({ status: 409 });
    await f.db.query(
      "UPDATE library_books SET enrichment=jsonb_set(enrichment,'{autoBibliography,afterValues,description}','\"New intro\"') WHERE id=$1",
      [id],
    );
    await expect(
      selectBookInformation(f.db, "owner", { ...request, expectedVersion: 2 }),
    ).rejects.toMatchObject({ status: 409 });
  } finally {
    await f.pg.close();
  }
});

it("selects one bibliography field without changing other fields or provider alternatives", async () => {
  const f = await testDatabase();
  try {
    const id = randomUUID(),
      itemId = randomUUID();
    await f.db.query(
      "INSERT INTO library_books(id,owner_id,title,formats) VALUES($1,'owner','Original',ARRAY['paper'])",
      [id],
    );
    const store = createCurationStore(f.db),
      run = await store.begin("owner", "scope", "test");
    const referenceId = randomUUID();
    await f.db.query(
      "INSERT INTO library_reference_sources(id,owner_id,source_kind,source_id,source_version,url,provider,title,content_hash,excerpt,edition_match) VALUES($1,'owner','book',$2,'1','https://source.test/book','Provider','Original','hash','Original','isbn')",
      [referenceId, id],
    );
    const applied = await store.apply("owner", run, [
      {
        id: itemId,
        source: { kind: "book", id, version: "1" },
        kind: "bibliography",
        proposedValue: {
          publisher: "Provider press",
          author: "Provider author",
        },
        evidence: { quote: "Original", referenceId },
        coverage: "metadata",
        origin: "provider",
        generator: "test",
      },
    ]);
    expect(applied.applied).toBe(1);
    const before = (await store.list("owner", "book", id))[0];
    await selectBookInformation(f.db, "owner", {
      bookId: id,
      expectedVersion: 1,
      field: "publisher",
      itemId,
      valueKey: informationValueKey("publisher", "Provider press"),
    });
    const after = (await store.list("owner", "book", id)).find(
      (item: any) => item.id === before.id,
    )!;
    expect(after.value).toEqual(before.value);
    expect(after.evidence).toEqual(before.evidence);
    expect(after.state).toBe("active");
    const details = await readCurationDetails(f.db, "owner", "book", id);
    expect(details.informationSelections.publisher.itemId).toBe(itemId);
    expect(details.informationSelections.author).toBeUndefined();
  } finally {
    await f.pg.close();
  }
});
