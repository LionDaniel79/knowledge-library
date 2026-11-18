import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import {
  createCurationStore,
  readCurationDetails,
} from "../src/server/curation-store";
import { selectBookInformation } from "../src/server/book-information-selection";
import { informationValueKey } from "../src/lib/unified-book-information";
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
