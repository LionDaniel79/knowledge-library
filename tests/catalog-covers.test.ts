import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { createLibraryStore } from "../src/server/library-store";
import { createCurationStore } from "../src/server/curation-store";
import { collectBookReference } from "../src/local/curation/catalog";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  fixture = await testDatabase();
});
afterAll(async () => fixture?.pg.close());

async function setup(owner: string) {
  const library = createLibraryStore(fixture.db);
  const book = await library.mutate(owner, {
    requestId: randomUUID(),
    type: "addBook",
    payload: { title: "내 책", isbn: "9780306406157", formats: ["paper"] },
  });
  const before = (await library.snapshot(owner)).books[0];
  const result = await collectBookReference(
    fixture.db,
    owner,
    { kind: "book", id: book.id!, version: "1" },
    {
      provider: "도서관 정보나루",
      url: "https://data4library.kr",
      isbn: "9780306406157",
      title: "제공자 제목",
      facts: {
        title: "제공자 제목",
        author: "저자",
        publisher: "출판사",
        isbn: "9780306406157",
        coverUrl: "https://images.example.org/edition-cover.jpg",
      },
    },
    true,
  );
  const item = (
    await createCurationStore(fixture.db).list(owner, "book", book.id!)
  )[0];
  return { library, book, before, item, runId: result.runId! };
}

it("shows an ISBN-matched provider cover separately without changing the original book", async () => {
  const { library, before } = await setup("cover-owner");
  const book = (await library.snapshot("cover-owner")).books[0];
  expect(book.catalogCoverUrl).toBe(
    "https://images.example.org/edition-cover.jpg",
  );
  const { catalogCoverUrl, ...original } = book;
  expect(original).toEqual(before);
  expect((await library.snapshot("other-owner")).books).toEqual([]);
});

it("removes hidden, stale and rolled-back covers from the displayed library", async () => {
  const { library, book, item } = await setup("cover-state");
  const store = createCurationStore(fixture.db);
  await store.edit("cover-state", item.id, 1, {
    value: item.value,
    state: "hidden",
  });
  expect(
    (await library.snapshot("cover-state")).books[0].catalogCoverUrl,
  ).toBeUndefined();
  await store.edit("cover-state", item.id, 2, {
    value: item.value,
    state: "active",
  });
  expect(
    (await library.snapshot("cover-state")).books[0].catalogCoverUrl,
  ).toBeTruthy();
  await library.mutate("cover-state", {
    requestId: randomUUID(),
    type: "editBook",
    payload: {
      id: book.id,
      expectedVersion: 1,
      title: "다른 판본",
      isbn: "9788999727764",
      formats: ["paper"],
    },
  });
  expect(
    (await library.snapshot("cover-state")).books[0].catalogCoverUrl,
  ).toBeUndefined();
  const rollback = await setup("cover-rollback");
  await store.rollback("cover-rollback", rollback.runId);
  expect(
    (await rollback.library.snapshot("cover-rollback")).books[0]
      .catalogCoverUrl,
  ).toBeUndefined();
});

it("does not display a cover with a mismatched ISBN or an unsafe URL", async () => {
  const { library, item } = await setup("cover-validation");
  const store = createCurationStore(fixture.db);
  await store.edit("cover-validation", item.id, 1, {
    value: { ...item.value, isbn: "9788999727764" },
    state: "active",
  });
  expect(
    (await library.snapshot("cover-validation")).books[0].catalogCoverUrl,
  ).toBeUndefined();
  await store.edit("cover-validation", item.id, 2, {
    value: { ...item.value, coverUrl: "javascript:alert(1)" },
    state: "active",
  });
  expect(
    (await library.snapshot("cover-validation")).books[0].catalogCoverUrl,
  ).toBeUndefined();
});

it("stops using an enriched PDF cover when the material is classified as metadata-only", async () => {
  const { library, book } = await setup("cover-scope");
  await fixture.db.query(
    "UPDATE library_books SET source_data=$1 WHERE id=$2",
    [JSON.stringify({ app: "Local PDF" }), book.id],
  );
  await fixture.db.query(
    "INSERT INTO library_documents(id,owner_id,book_id,root,path,relative_path,bytes,mtime_ns,processing_scope) VALUES($1,'cover-scope',$2,'root','book.pdf','book.pdf',1,'1','full')",
    [randomUUID(), book.id],
  );
  expect(
    (await library.snapshot("cover-scope")).books[0].catalogCoverUrl,
  ).toBeTruthy();
  await fixture.db.query(
    "UPDATE library_documents SET processing_scope='metadata_only' WHERE owner_id='cover-scope'",
  );
  expect(
    (await library.snapshot("cover-scope")).books[0].catalogCoverUrl,
  ).toBeUndefined();
});
