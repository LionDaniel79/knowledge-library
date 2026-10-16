import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { createLibraryStore } from "../src/server/library-store";
import {
  createCurationStore,
  readCurationDetails,
} from "../src/server/curation-store";
import { searchLibrary } from "../src/server/library-search";
import { buildPdfOutline } from "../src/local/curation/pdf-outline";
import {
  collectPdfOutline,
  retireUnusablePdfOutlines,
} from "../src/local/curation/pdf-outline-store";
let fixture: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  fixture = await testDatabase();
});
afterAll(async () => fixture?.pg.close());
it("replaces a cleaned automatic outline for the same PDF while preserving its previous value in history", async () => {
  const owner = "outline-cleaned",
    { source, outline } = await setup(owner);
  await collectPdfOutline(
    fixture.db,
    owner,
    source,
    {
      ...outline,
      entries: [...outline.entries, { title: "0_001", page: 1, level: 0 }],
      totalEntries: 2,
    },
    () => true,
  );
  await collectPdfOutline(fixture.db, owner, source, outline, () => true);
  const detail = await readCurationDetails(
    fixture.db,
    owner,
    "book",
    source.id,
  );
  expect(detail.items).toHaveLength(1);
  expect(detail.items[0].value).toEqual(outline);
  expect(detail.history).toHaveLength(3);
});
it("retires only unusable generated outlines, keeps history and protects manual/hidden entries", async () => {
  for (const mode of ["automatic", "manual", "hidden"] as const) {
    const owner = `outline-quality-${mode}`,
      { source, outline } = await setup(owner);
    const oldOutline = {
      ...outline,
      entries: [{ title: "0_001", page: 1, level: 0 }],
      totalEntries: 1,
    };
    await collectPdfOutline(fixture.db, owner, source, oldOutline, () => true);
    const old = (
      await createCurationStore(fixture.db).list(owner, "book", source.id)
    )[0];
    if (mode !== "automatic")
      await createCurationStore(fixture.db).edit(owner, old.id, 1, {
        value: oldOutline,
        state: mode === "hidden" ? "hidden" : "active",
      });
    await fixture.db.query(
      "UPDATE library_books SET version=2 WHERE owner_id=$1 AND id=$2",
      [owner, source.id],
    );
    source.version = "2";
    expect(
      await retireUnusablePdfOutlines(
        fixture.db,
        "foreign",
        source,
        {
          id: outline.documentId,
          signature: outline.signature,
          pageCount: 30,
          processingScope: "full",
          status: "ready",
        },
        () => true,
      ),
    ).toBe(0);
    const retired = await retireUnusablePdfOutlines(
      fixture.db,
      owner,
      source,
      {
        id: outline.documentId,
        signature: outline.signature,
        pageCount: 30,
        processingScope: "full",
        status: "ready",
      },
      () => true,
    );
    expect(retired).toBe(mode === "automatic" ? 1 : 0);
    const saved = (
      await fixture.db.query(
        "SELECT state,value FROM library_curation_items WHERE id=$1",
        [old.id],
      )
    ).rows[0];
    expect(saved.value).toEqual(oldOutline);
    expect(saved.state).toBe(
      mode === "automatic"
        ? "rolled_back"
        : mode === "hidden"
          ? "hidden"
          : "active",
    );
    if (mode === "automatic")
      expect(
        (await readCurationDetails(fixture.db, owner, "book", source.id))
          .history,
      ).toHaveLength(2);
  }
});
it("marks replaced PDF outlines stale and searches only the recollected document version", async () => {
  const owner = "outline-replaced",
    { source, outline } = await setup(owner);
  await collectPdfOutline(fixture.db, owner, source, outline, () => true);
  await fixture.db.query(
    "UPDATE library_documents SET bytes=200,mtime_ns='99' WHERE owner_id=$1 AND id=$2",
    [owner, outline.documentId],
  );
  const old = await readCurationDetails(fixture.db, owner, "book", source.id);
  expect(old.version).toBe("1");
  expect(old.items[0]).toMatchObject({
    source_stale: true,
    document_current: false,
  });
  expect(
    (
      await searchLibrary(fixture.db, owner, {
        text: "정서 조절",
        layer: "auxiliary",
      })
    ).items,
  ).toEqual([]);
  await collectPdfOutline(
    fixture.db,
    owner,
    source,
    {
      ...outline,
      signature: "200:99",
      entries: [{ title: "정서 조절과 새로운 관계", page: 13, level: 0 }],
    },
    () => true,
  );
  const details = await readCurationDetails(
    fixture.db,
    owner,
    "book",
    source.id,
  );
  expect(details.items).toHaveLength(2);
  expect(details.items.filter((i) => !i.source_stale)).toHaveLength(1);
  expect(
    (
      await searchLibrary(fixture.db, owner, {
        text: "정서 조절",
        layer: "auxiliary",
      })
    ).items,
  ).toHaveLength(1);
});
async function setup(owner: string) {
  const library = createLibraryStore(fixture.db);
  const book = await library.mutate(owner, {
    requestId: randomUUID(),
    type: "addBook",
    payload: { title: "정서의 발견", formats: ["pdf"] },
  });
  const id = randomUUID();
  await fixture.db.query(
    "UPDATE library_books SET source_data=$3 WHERE owner_id=$1 AND id=$2",
    [owner, book.id, JSON.stringify({ app: "Local PDF", recordId: id })],
  );
  await fixture.db.query(
    "INSERT INTO library_documents(id,owner_id,book_id,root,path,relative_path,bytes,mtime_ns,processing_scope) VALUES($1,$2,$3,'root',$4,$4,100,'12','full')",
    [id, owner, book.id, `${id}.pdf`],
  );
  return {
    library,
    source: { kind: "book" as const, id: book.id!, version: "1" },
    outline: buildPdfOutline(
      {
        id,
        signature: "100:12",
        pageCount: 30,
        status: "ready",
        processingScope: "full",
      },
      [{ title: "정서 조절과 관계", page: 12, level: 0 }],
    )!,
  };
}
it("stores a searchable outline separately, with document evidence and unchanged personal records", async () => {
  const { library, source, outline } = await setup("outline-owner");
  const before = await library.snapshot("outline-owner");
  expect(
    await collectPdfOutline(
      fixture.db,
      "outline-owner",
      source,
      outline,
      () => true,
    ),
  ).toMatchObject({ applied: 1 });
  expect(await library.snapshot("outline-owner")).toEqual(before);
  const detail = await readCurationDetails(
    fixture.db,
    "outline-owner",
    "book",
    source.id,
  );
  expect(detail.items).toHaveLength(1);
  expect(detail.references).toHaveLength(1);
  expect(detail.history).toHaveLength(1);
  await expect(
    readCurationDetails(fixture.db, "foreign-owner", "book", source.id),
  ).rejects.toThrow();
  const hits = await searchLibrary(fixture.db, "outline-owner", {
    text: "정서 조절",
    layer: "auxiliary",
  });
  expect(hits.items[0]).toMatchObject({
    coverage: "toc",
    source: { id: source.id },
  });
  expect(
    (
      await fixture.db.query(
        "SELECT edition_match, facts FROM library_reference_sources WHERE owner_id='outline-owner'",
      )
    ).rows[0],
  ).toMatchObject({
    edition_match: "document",
    facts: { documentId: outline.documentId, signature: outline.signature },
  });
  expect(
    await collectPdfOutline(
      fixture.db,
      "outline-owner",
      source,
      outline,
      () => true,
    ),
  ).toMatchObject({ applied: 0 });
});
it("preserves hidden/manual outlines and rejects stale, foreign, changed or excluded sources", async () => {
  const { source, outline } = await setup("outline-guard");
  for (const [owner, version, verifies] of [
    ["other", "1", true],
    ["outline-guard", "2", true],
    ["outline-guard", "1", false],
  ] as const)
    expect(
      (
        await collectPdfOutline(
          fixture.db,
          owner,
          { ...source, version },
          outline,
          () => verifies,
        )
      ).applied,
    ).toBe(0);
  await fixture.db.query(
    "UPDATE library_documents SET processing_scope='metadata_only' WHERE id=$1",
    [outline.documentId],
  );
  expect(
    (
      await collectPdfOutline(
        fixture.db,
        "outline-guard",
        source,
        outline,
        () => true,
      )
    ).applied,
  ).toBe(0);
  await fixture.db.query(
    "UPDATE library_documents SET processing_scope='full' WHERE id=$1",
    [outline.documentId],
  );
  await collectPdfOutline(
    fixture.db,
    "outline-guard",
    source,
    outline,
    () => true,
  );
  const item = (
    await createCurationStore(fixture.db).list(
      "outline-guard",
      "book",
      source.id,
    )
  )[0];
  await expect(
    createCurationStore(fixture.db).edit("outline-guard", item.id, 1, {
      value: { ...outline, documentId: randomUUID() },
      state: "active",
    }),
  ).rejects.toThrow("문서");
  await createCurationStore(fixture.db).edit("outline-guard", item.id, 1, {
    value: {
      ...outline,
      entries: [{ title: "내가 정리한 목차", page: 12, level: 0 }],
    },
    state: "hidden",
  });
  expect(
    (
      await collectPdfOutline(
        fixture.db,
        "outline-guard",
        source,
        outline,
        () => true,
      )
    ).applied,
  ).toBe(0);
  const items = await createCurationStore(fixture.db).list(
    "outline-guard",
    "book",
    source.id,
  );
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ state: "hidden", reviewed_by: "human" });
  expect(
    (
      await searchLibrary(fixture.db, "outline-guard", {
        text: "정서 조절",
        layer: "all",
      })
    ).items,
  ).toHaveLength(0);
});
