import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { createLibraryStore } from "../src/server/library-store";
import {
  importCatalogReview,
  importCatalogReviewBatch,
  readCatalogReviews,
  decideCatalogReview,
} from "../src/server/catalog-review-store";
let f: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  f = await testDatabase();
});
it("batch import is owner/version scoped and never resets reviewed decisions", async () => {
  const x = await fixture();
  expect(await importCatalogReviewBatch(f.db, x.owner, [x])).toBe(1);
  expect(await importCatalogReviewBatch(f.db, x.owner, [x])).toBe(0);
  expect(await importCatalogReviewBatch(f.db, "other", [x])).toBe(0);
  expect(
    await importCatalogReviewBatch(f.db, x.owner, [{ ...x, sourceVersion: 2 }]),
  ).toBe(0);
  const row = (await readCatalogReviews(f.db, x.owner, {})).items![0];
  await decideCatalogReview(f.db, x.owner, {
    id: row.id,
    expectedVersion: 1,
    requestId: randomUUID(),
    action: "reject",
  });
  await importCatalogReviewBatch(f.db, x.owner, [x]);
  expect(
    (await readCatalogReviews(f.db, x.owner, { status: "rejected" })).total,
  ).toBe(1);
});
afterAll(async () => {
  await f.pg.close();
});
it("applies an unchanged eligible PDF even when JSONB reorders snapshot keys", async () => {
  const x = await fixture();
  await f.db.query(
    "insert into library_documents(id,owner_id,book_id,root,path,relative_path,bytes,mtime_ns,processing_scope,material_kind) values($1,$2,$3,'r','p','p',1,'1','full','book')",
    [randomUUID(), x.owner, x.bookId],
  );
  await importCatalogReview(f.db, x.owner, x);
  const row = (await readCatalogReviews(f.db, x.owner, {})).items![0];
  await f.db.query(
    "update library_catalog_reviews set document_versions=jsonb_build_array(jsonb_build_object('material_kind','book','processing_scope','full','mtime_ns','1','bytes','1','id',(document_versions->0->>'id'))) where id=$1",
    [row.id],
  );
  await expect(
    decideCatalogReview(f.db, x.owner, {
      id: row.id,
      expectedVersion: 1,
      requestId: randomUUID(),
      action: "apply",
      sameEdition: true,
      fields: ["isbn"],
    }),
  ).resolves.toMatchObject({ action: "apply" });
});
const record = {
  provider: "예스24" as const,
  url: "https://www.yes24.com/product/goods/1234",
  isbn: "9780306406157",
  title: "후보 책",
  facts: {
    title: "후보 책",
    author: "후보 저자",
    publisher: "출판사",
    isbn: "9780306406157",
    coverUrl: "https://image.yes24.com/goods/1234/L",
  },
  toc: ["1장"],
  description: "소개",
};
async function fixture() {
  const owner = randomUUID();
  const b = await createLibraryStore(f.db).mutate(owner, {
    requestId: randomUUID(),
    type: "addBook",
    payload: {
      title: "현재 책",
      author: "내 표기",
      formats: ["paper"],
      tags: ["유지"],
    },
  });
  return { owner, bookId: b.id!, sourceVersion: 1, record };
}
it("imports once, isolates owners and leaves deferred/rejected books unchanged", async () => {
  const x = await fixture();
  await importCatalogReview(f.db, x.owner, x);
  await importCatalogReview(f.db, x.owner, x);
  const page = await readCatalogReviews(f.db, x.owner, {});
  expect(page.total).toBe(1);
  expect((await readCatalogReviews(f.db, "other", {})).total).toBe(0);
  const id = page.items![0].id;
  await decideCatalogReview(f.db, x.owner, {
    id,
    expectedVersion: 1,
    requestId: randomUUID(),
    action: "defer",
  });
  expect(
    (
      await f.db.query("select title from library_books where id=$1", [
        x.bookId,
      ])
    ).rows[0].title,
  ).toBe("현재 책");
  await importCatalogReview(f.db, x.owner, x);
  expect(
    (await readCatalogReviews(f.db, x.owner, { status: "deferred" })).total,
  ).toBe(1);
});
it("requires edition confirmation, applies only selected fields, preserves notes and records history", async () => {
  const x = await fixture();
  await importCatalogReview(f.db, x.owner, x);
  const id = (await readCatalogReviews(f.db, x.owner, {})).items![0].id;
  const input = {
    id,
    expectedVersion: 1,
    requestId: randomUUID(),
    action: "apply",
    sameEdition: true,
    fields: ["isbn", "publisher"],
  };
  await expect(
    decideCatalogReview(f.db, x.owner, { ...input, sameEdition: false }),
  ).rejects.toThrow();
  await decideCatalogReview(f.db, x.owner, input);
  await decideCatalogReview(f.db, x.owner, input);
  const b = (
    await f.db.query("select * from library_books where id=$1", [x.bookId])
  ).rows[0];
  expect(b).toMatchObject({
    title: "현재 책",
    author: "내 표기",
    isbn: record.isbn,
    publisher: "출판사",
    tags: ["유지"],
    version: 2,
  });
  expect(
    (
      await f.db.query(
        "select * from library_curation_items where owner_id=$1 and kind='toc'",
        [x.owner],
      )
    ).rows,
  ).toHaveLength(1);
  expect(
    (
      await f.db.query("select * from library_revisions where owner_id=$1", [
        x.owner,
      ])
    ).rows.length,
  ).toBeGreaterThan(0);
});
it("rejects stale books and excludes metadata-only PDFs", async () => {
  const x = await fixture();
  await importCatalogReview(f.db, x.owner, x);
  const id = (await readCatalogReviews(f.db, x.owner, {})).items![0].id;
  await f.db.query("update library_books set version=2 where id=$1", [
    x.bookId,
  ]);
  await expect(
    decideCatalogReview(f.db, x.owner, {
      id,
      expectedVersion: 1,
      requestId: randomUUID(),
      action: "apply",
      sameEdition: true,
      fields: ["isbn"],
    }),
  ).rejects.toThrow();
  const y = await fixture();
  await f.db.query(
    "insert into library_documents(id,owner_id,book_id,root,path,relative_path,bytes,mtime_ns) values($1,$2,$3,'r','p','p',1,'1')",
    [randomUUID(), y.owner, y.bookId],
  );
  expect(await importCatalogReview(f.db, y.owner, y)).toBeNull();
});
