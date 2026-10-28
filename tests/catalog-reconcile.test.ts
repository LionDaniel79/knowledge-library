import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { createLibraryStore } from "../src/server/library-store";
import {
  importCatalogReviewBatch,
  readCatalogReviews,
} from "../src/server/catalog-review-store";
import { reconcileCatalogReviews } from "../src/local/curation/catalog-reconcile";
let f: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  f = await testDatabase();
});
afterAll(async () => {
  await f.pg.close();
});
const record = {
  provider: "예스24" as const,
  url: "https://www.yes24.com/product/goods/1",
  isbn: "9780306406157",
  title: "같은 책",
  facts: {
    isbn: "9780306406157",
    title: "같은 책",
    author: "저자",
    publisher: "출판사",
    coverUrl: "",
  },
  toc: ["1장"],
};
it("resolves matching ISBN candidates per owned copy and prefers the candidate with a cover", async () => {
  const owner = randomUUID(),
    store = createLibraryStore(f.db);
  const ids = [];
  for (let i = 0; i < 2; i++)
    ids.push(
      (
        await store.mutate(owner, {
          type: "addBook",
          requestId: randomUUID(),
          payload: { ...record.facts, formats: ["paper"] },
        })
      ).id!,
    );
  for (const id of ids)
    await importCatalogReviewBatch(f.db, owner, [
      { bookId: id, sourceVersion: 1, record },
      {
        bookId: id,
        sourceVersion: 1,
        record: {
          ...record,
          url: "https://www.yes24.com/product/goods/2",
          facts: { ...record.facts, coverUrl: "https://image.yes24.com/a.jpg" },
        },
      },
    ]);
  const cover = async () => ({
    id: randomUUID(),
    url: "/api/book-covers/fixture",
  });
  const result = await reconcileCatalogReviews(f.db, owner, true, cover);
  expect(result.resolvedBooks).toBe(2);
  expect((await readCatalogReviews(f.db, owner, {})).total).toBe(0);
  expect(
    (
      await f.db.query(
        "SELECT count(*)::int n FROM library_books WHERE owner_id=$1",
        [owner],
      )
    ).rows[0].n,
  ).toBe(2);
  expect(
    (await reconcileCatalogReviews(f.db, owner, true, cover)).resolvedBooks,
  ).toBe(0);
});
it("keeps an ambiguous edition, deduplicates its same-ISBN alternatives and does not touch another owner", async () => {
  const owner = randomUUID(),
    b = await createLibraryStore(f.db).mutate(owner, {
      type: "addBook",
      requestId: randomUUID(),
      payload: { title: "다른 책", formats: ["paper"] },
    });
  await importCatalogReviewBatch(f.db, owner, [
    { bookId: b.id!, sourceVersion: 1, record },
    {
      bookId: b.id!,
      sourceVersion: 1,
      record: { ...record, url: "https://www.yes24.com/product/goods/3" },
    },
  ]);
  await reconcileCatalogReviews(f.db, "other", true);
  expect((await readCatalogReviews(f.db, owner, {})).total).toBe(2);
  const result = await reconcileCatalogReviews(f.db, owner, true);
  expect(result.resolvedBooks).toBe(0);
  expect(result.superseded).toBe(1);
  expect((await readCatalogReviews(f.db, owner, {})).total).toBe(1);
});
