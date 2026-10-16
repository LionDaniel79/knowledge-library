import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { createLibraryStore } from "../src/server/library-store";
import {
  createCurationStore,
  readCurationDetails,
} from "../src/server/curation-store";
import { searchLibrary } from "../src/server/library-search";
import { buildPrintedToc } from "../src/local/curation/printed-toc";
import { collectPrintedToc } from "../src/local/curation/printed-toc-store";
let f: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  f = await testDatabase();
});
afterAll(async () => {
  await f?.pg.close();
});
async function setup(owner: string) {
  const library = createLibraryStore(f.db),
    id = randomUUID();
  const book = await library.mutate(owner, {
    requestId: randomUUID(),
    type: "addBook",
    payload: { title: "책의 차례", formats: ["pdf"] },
  });
  await f.db.query(
    "UPDATE library_books SET source_data=$3 WHERE owner_id=$1 AND id=$2",
    [owner, book.id, JSON.stringify({ app: "Local PDF", recordId: id })],
  );
  await f.db.query(
    "INSERT INTO library_documents(id,owner_id,book_id,root,path,relative_path,bytes,mtime_ns,processing_scope) VALUES($1,$2,$3,'root',$4,$4,100,'12','full')",
    [id, owner, book.id, `${id}.pdf`],
  );
  const toc = buildPrintedToc(
    {
      id,
      signature: "100:12",
      pageCount: 100,
      status: "ready",
      processingScope: "full",
    },
    [
      {
        pageNumber: 5,
        method: "ocr_unverified",
        text: "차례\n정서 조절 ........ 10\n관계와 의미 ........ 20\n신앙과 과학 ........ 30",
      },
    ],
  )!;
  return {
    library,
    toc,
    source: { kind: "book" as const, id: book.id!, version: "1" },
  };
}
it("preserves the library, stores document provenance once, searches text without implementation fields, and invalidates changed files", async () => {
  const owner = "printed-provenance",
    { library, toc, source } = await setup(owner),
    before = await library.snapshot(owner);
  expect(
    await collectPrintedToc(f.db, owner, source, toc, () => true),
  ).toMatchObject({ applied: 1 });
  expect(await library.snapshot(owner)).toEqual(before);
  expect(
    await collectPrintedToc(f.db, owner, source, toc, () => true),
  ).toMatchObject({ applied: 0 });
  const detail = await readCurationDetails(f.db, owner, "book", source.id);
  expect(detail.items).toHaveLength(1);
  expect(detail.references).toHaveLength(1);
  expect(
    (
      await searchLibrary(f.db, owner, {
        text: "정서 조절",
        layer: "auxiliary",
      })
    ).items[0].quote,
  ).toBe(toc.text);
  await f.db.query("UPDATE library_documents SET bytes=101 WHERE id=$1", [
    toc.documentId,
  ]);
  expect(
    (await readCurationDetails(f.db, owner, "book", source.id)).items[0],
  ).toMatchObject({ source_stale: true, document_current: false });
  expect(
    (
      await searchLibrary(f.db, owner, {
        text: "정서 조절",
        layer: "auxiliary",
      })
    ).items,
  ).toEqual([]);
});
it("allows separate human wording and hiding while keeping the exact original excerpt and pages immutable", async () => {
  const owner = "printed-edit",
    { toc, source } = await setup(owner),
    s = createCurationStore(f.db);
  await collectPrintedToc(f.db, owner, source, toc, () => true);
  const old = (await s.list(owner, "book", source.id))[0];
  for (const changed of [
    { ...toc, documentId: randomUUID() },
    { ...toc, text: "바뀐 원문" },
    { ...toc, pages: [{ ...toc.pages[0], page: 6 }] },
  ])
    await expect(
      s.edit(owner, old.id, 1, { value: changed, state: "active" }),
    ).rejects.toThrow();
  const value = { ...toc, editedText: "내가 정리한 목차와 질문" };
  await s.edit(owner, old.id, 1, { value, state: "active" });
  expect(
    (
      await searchLibrary(f.db, owner, {
        text: "정리한 목차",
        layer: "auxiliary",
      })
    ).items[0].quote,
  ).toBe(value.editedText);
  expect(
    await collectPrintedToc(f.db, owner, source, toc, () => true),
  ).toMatchObject({ applied: 0 });
  await s.edit(owner, old.id, 2, { value, state: "hidden" });
  expect(
    await collectPrintedToc(f.db, owner, source, toc, () => true),
  ).toMatchObject({ applied: 0 });
  expect((await s.list(owner, "book", source.id))[0]).toMatchObject({
    state: "hidden",
    value,
  });
});
it("rejects foreign owners, stale book/files, excluded scope, and rolls back partial storage", async () => {
  const owner = "printed-guards",
    { toc, source } = await setup(owner);
  expect(
    await collectPrintedToc(f.db, "foreign", source, toc, () => true),
  ).toMatchObject({ applied: 0 });
  expect(
    await collectPrintedToc(
      f.db,
      owner,
      { ...source, version: "2" },
      toc,
      () => true,
    ),
  ).toMatchObject({ applied: 0 });
  expect(
    await collectPrintedToc(
      f.db,
      owner,
      source,
      { ...toc, signature: "other" },
      () => true,
    ),
  ).toMatchObject({ applied: 0 });
  expect(
    await collectPrintedToc(f.db, owner, source, toc, () => false),
  ).toMatchObject({ applied: 0 });
  await f.db.query(
    "UPDATE library_documents SET processing_scope='metadata_only' WHERE id=$1",
    [toc.documentId],
  );
  expect(
    await collectPrintedToc(f.db, owner, source, toc, () => true),
  ).toMatchObject({ applied: 0 });
  await f.db.query(
    "UPDATE library_documents SET processing_scope='full' WHERE id=$1",
    [toc.documentId],
  );
  const broken = {
    ...f.db,
    transaction: <T>(fn: (tx: typeof f.db) => Promise<T>) =>
      f.db.transaction((tx) =>
        fn({
          ...f.db,
          query: async (s, p) => {
            if (s.startsWith("INSERT INTO library_curation_items"))
              throw Error("storage failed");
            return tx.query(s, p);
          },
        }),
      ),
  };
  await expect(
    collectPrintedToc(broken, owner, source, toc, () => true),
  ).rejects.toThrow("storage failed");
  expect(
    (
      await f.db.query(
        "SELECT count(*)::int n FROM library_reference_sources WHERE owner_id=$1",
        [owner],
      )
    ).rows[0].n,
  ).toBe(0);
});
