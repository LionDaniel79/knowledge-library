import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { createLibraryStore } from "../src/server/library-store";
import {
  catalogSupplementProof,
  catalogEditionProof,
} from "../src/lib/catalog-supplement";
import { collectSupplementRecords } from "../src/local/curation/catalog-supplement";
import {
  supplementBook,
  libraryCorroborates,
} from "../src/local/curation/catalog-supplement";
import { bookSelect } from "../src/server/book-records";
import { collectBookReference } from "../src/local/curation/catalog";
import { importCatalogReviewBatch } from "../src/server/catalog-review-store";
import {
  claimCatalogSupplement,
  catalogCollectorScope,
} from "../src/server/catalog-supplement-queue";
const facts = {
  title: "테스트 책",
  author: "홍길동",
  publisher: "출판사",
  isbn: "9780306406157",
  coverUrl: "https://image.yes24.com/1.jpg",
};
it("allows missing facts for a matching ISBN, but preserves conflicting editions", () => {
  expect(
    catalogSupplementProof({ ...facts, author: "", publisher: "" }, facts)
      .certain,
  ).toBe(true);
  for (const change of [
    { isbn: "9780140449136" },
    { title: "다른 책" },
    { author: "다른 저자" },
    { publisher: "다른 출판사" },
  ])
    expect(catalogSupplementProof({ ...facts, ...change }, facts).certain).toBe(
      false,
    );
});
it("accepts ISBN-bound cover evidence despite abbreviated titles and author spellings, rejecting explicit volume conflicts", () => {
  expect(
    catalogEditionProof(
      { ...facts, title: "로마서 강해 1 (반양장)", author: "마틴 로이드 존스" },
      {
        ...facts,
        title: "로마서 강해 1",
        author: "D.M.로이드 존스 저/서문강 역",
      },
    ).certain,
  ).toBe(true);
  expect(
    catalogEditionProof(
      { ...facts, title: "장미의 이름" },
      { ...facts, title: "장미의 이름 (상)" },
    ).certain,
  ).toBe(true);
  expect(
    catalogEditionProof(
      { ...facts, title: "로마서 강해 1" },
      { ...facts, title: "로마서 강해 2" },
    ).certain,
  ).toBe(false);
  expect(
    catalogEditionProof(
      { ...facts, title: "장미의 이름 (하)" },
      { ...facts, title: "장미의 이름 (상)" },
    ).certain,
  ).toBe(false);
  expect(
    catalogEditionProof(facts, { ...facts, author: "완전히 다른 저자" })
      .certain,
  ).toBe(false);
  expect(
    catalogEditionProof(facts, { ...facts, publisher: "완전히 다른 출판사" })
      .certain,
  ).toBe(false);
});
it("collects both providers by ISBN even when Yes24 succeeds, preserving partial success", async () => {
  const calls: string[] = [];
  const record = {
    provider: "예스24" as const,
    title: facts.title,
    isbn: facts.isbn,
    url: "https://www.yes24.com/product/goods/1",
    facts,
    toc: ["첫 장"],
  };
  const result = await collectSupplementRecords(
    facts.isbn,
    async (provider) => {
      calls.push(provider);
      if (provider === "library") throw Error("private key must not leak");
      return [record];
    },
  );
  expect(calls).toEqual(["yes24", "library"]);
  expect(result.records).toEqual([record]);
  expect(result.retry).toBe(true);
  expect(JSON.stringify(result)).not.toContain("private key");
});
let f: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  f = await testDatabase();
});
afterAll(async () => {
  await f.pg.close();
});
it("queues a saved ISBN book without a provider call and does not requeue unrelated edits", async () => {
  const owner = randomUUID(),
    store = createLibraryStore(f.db);
  const added = await store.mutate(owner, {
    type: "addBook",
    requestId: randomUUID(),
    payload: { ...facts, formats: ["paper"] },
  });
  const first = (
    await f.db.query("SELECT * FROM library_books WHERE owner_id=$1", [owner])
  ).rows[0];
  expect(first.enrichment.catalogSupplement).toMatchObject({
    state: "pending",
    isbn: facts.isbn,
    owner,
  });
  await store.mutate(owner, {
    type: "editBook",
    requestId: randomUUID(),
    payload: {
      ...facts,
      id: added.id,
      expectedVersion: 1,
      formats: ["paper"],
      shelf: "changed",
    },
  });
  const second = (
    await f.db.query("SELECT * FROM library_books WHERE owner_id=$1", [owner])
  ).rows[0];
  expect(second.enrichment.catalogSupplement).toEqual(
    first.enrichment.catalogSupplement,
  );
});
it("leases queued work once across collectors and isolates the configured scope", async () => {
  const owner = randomUUID(),
    b = await createLibraryStore(f.db).mutate(owner, {
      type: "addBook",
      requestId: randomUUID(),
      payload: { ...facts, formats: ["paper"] },
    });
  const scope = catalogCollectorScope(process.env.LIBRARY_OWNER_EMAIL ?? "");
  expect(
    await claimCatalogSupplement(f.db, owner, b.id!, "another-scope"),
  ).toBeNull();
  expect(
    await claimCatalogSupplement(f.db, owner, b.id!, scope),
  ).not.toBeNull();
  expect(await claimCatalogSupplement(f.db, owner, b.id!, scope)).toBeNull();
});
it("fills missing facts and cover, preserves manual KDC and visible reviewed curation, rejects stale writes", async () => {
  const owner = randomUUID(),
    store = createLibraryStore(f.db);
  const added = await store.mutate(owner, {
    type: "addBook",
    requestId: randomUUID(),
    payload: {
      title: facts.title,
      isbn: facts.isbn,
      formats: ["paper"],
      category: "800",
    },
  });
  const record = {
    provider: "예스24" as const,
    title: facts.title,
    isbn: facts.isbn,
    url: "https://www.yes24.com/product/goods/1",
    facts,
    toc: ["내 목차"],
    description: "내가 확인한 소개",
  };
  await collectBookReference(
    f.db,
    owner,
    { kind: "book", id: added.id!, version: "1" },
    record,
    true,
  );
  await f.db.query(
    "UPDATE library_curation_items SET reviewed_by='human' WHERE owner_id=$1",
    [owner],
  );
  const book = (
    await f.db.query(`SELECT ${bookSelect} FROM library_books WHERE id=$1`, [
      added.id,
    ])
  ).rows[0];
  const saveCover = async () => ({
    id: randomUUID(),
    url: "/api/book-covers/fixture",
  });
  const library = {
    ...record,
    provider: "도서관 정보나루" as const,
    url: "https://www.data4library.kr",
    facts: {
      ...facts,
      category: "100",
      classification: { verified: true, code: "100", method: "ISBN 일치" },
    },
  };
  await supplementBook(f.db, owner, book, [record, library], false, saveCover);
  const result = (
    await f.db.query(`SELECT ${bookSelect} FROM library_books WHERE id=$1`, [
      added.id,
    ])
  ).rows[0];
  expect(result).toMatchObject({
    author: facts.author,
    publisher: facts.publisher,
    coverUrl: facts.coverUrl,
    category: "800",
    version: 2,
  });
  expect(
    (
      await f.db.query(
        "SELECT kind FROM library_curation_items WHERE owner_id=$1 AND source_version='2' AND reviewed_by='human'",
        [owner],
      )
    ).rows,
  ).toHaveLength(3);
  expect(
    await supplementBook(f.db, owner, book, [record], false, saveCover),
  ).toMatchObject({ state: "stale" });
});
it("keeps a human-hidden cover and contents hidden after an unrelated edit", async () => {
  const owner = randomUUID(),
    store = createLibraryStore(f.db);
  const added = await store.mutate(owner, {
    type: "addBook",
    requestId: randomUUID(),
    payload: { ...facts, coverUrl: "", formats: ["paper"] },
  });
  const record = {
    provider: "예스24" as const,
    title: facts.title,
    isbn: facts.isbn,
    url: "https://www.yes24.com/product/goods/1",
    facts,
    toc: ["숨긴 목차"],
  };
  await collectBookReference(
    f.db,
    owner,
    { kind: "book", id: added.id!, version: "1" },
    record,
    true,
  );
  await f.db.query(
    "UPDATE library_curation_items SET state='hidden',reviewed_by='human' WHERE owner_id=$1",
    [owner],
  );
  await store.mutate(owner, {
    type: "editBook",
    requestId: randomUUID(),
    payload: {
      ...facts,
      coverUrl: "",
      id: added.id,
      expectedVersion: 1,
      formats: ["paper"],
      shelf: "다른 책장",
    },
  });
  const book = (
    await f.db.query(`SELECT ${bookSelect} FROM library_books WHERE id=$1`, [
      added.id,
    ])
  ).rows[0];
  let downloads = 0;
  await supplementBook(f.db, owner, book, [record], false, async () => {
    downloads++;
    return { id: randomUUID(), url: "/api/book-covers/x" };
  });
  const current = (
    await f.db.query("SELECT cover_url FROM library_books WHERE id=$1", [
      added.id,
    ])
  ).rows[0];
  expect(downloads).toBe(0);
  expect(current.cover_url).toBe("");
  expect(
    (
      await f.db.query(
        "SELECT kind FROM library_curation_items WHERE owner_id=$1 AND source_version='2' AND state='active'",
        [owner],
      )
    ).rows,
  ).toHaveLength(0);
});
it("uses independent library identity to corroborate a bookstore credit variant without rewriting the reader author", async () => {
  const owner = randomUUID(),
    b = await createLibraryStore(f.db).mutate(owner, {
      type: "addBook",
      requestId: randomUUID(),
      payload: { ...facts, coverUrl: "", formats: ["paper"] },
    });
  const book = (
    await f.db.query(`SELECT ${bookSelect} FROM library_books WHERE id=$1`, [
      b.id,
    ])
  ).rows[0];
  const yes = {
    provider: "예스24" as const,
    title: facts.title,
    isbn: facts.isbn,
    url: "https://www.yes24.com/product/goods/1",
    facts: { ...facts, author: "편집자로 표기된 다른 이름" },
    toc: ["서점의 목차"],
  };
  const lib = {
    provider: "도서관 정보나루" as const,
    title: facts.title,
    isbn: facts.isbn,
    url: "https://www.data4library.kr",
    facts: { ...facts, coverUrl: "" },
  };
  await supplementBook(f.db, owner, book, [yes, lib], false, async () => ({
    id: randomUUID(),
    url: "/api/book-covers/fixture",
  }));
  expect(
    (
      await f.db.query(
        "SELECT value FROM library_curation_items WHERE owner_id=$1 AND kind='toc' AND state='active'",
        [owner],
      )
    ).rows[0]?.value,
  ).toEqual(["서점의 목차"]);
  expect(
    (await f.db.query("SELECT author FROM library_books WHERE id=$1", [b.id]))
      .rows[0].author,
  ).toBe(facts.author);
});
it("does not treat absent library credits as independent confirmation of conflicting bookstore credits", () => {
  const lib = {
    provider: "도서관 정보나루" as const,
    title: facts.title,
    isbn: facts.isbn,
    url: "https://www.data4library.kr",
    facts: { ...facts, author: "", publisher: "" },
  };
  expect(libraryCorroborates(facts, [lib])).toBe(false);
});
it("keeps a pending candidate usable when automatic classification advances the book version", async () => {
  const owner = randomUUID(),
    b = await createLibraryStore(f.db).mutate(owner, {
      type: "addBook",
      requestId: randomUUID(),
      payload: { ...facts, coverUrl: "", formats: ["paper"] },
    });
  const record = {
    provider: "예스24" as const,
    title: facts.title,
    isbn: facts.isbn,
    url: "https://www.yes24.com/product/goods/1",
    facts: { ...facts, coverUrl: "" },
  };
  await importCatalogReviewBatch(f.db, owner, [
    { bookId: b.id!, sourceVersion: 1, record },
  ]);
  const book = (
    await f.db.query(`SELECT ${bookSelect} FROM library_books WHERE id=$1`, [
      b.id,
    ])
  ).rows[0];
  await supplementBook(f.db, owner, book, [
    {
      ...record,
      provider: "도서관 정보나루",
      url: "https://www.data4library.kr",
      facts: {
        ...record.facts,
        category: "100",
        classification: { verified: true, code: "100", method: "ISBN 일치" },
      },
    },
  ]);
  const review = (
    await f.db.query(
      "SELECT source_version,version,book_snapshot FROM library_catalog_reviews WHERE book_id=$1",
      [b.id],
    )
  ).rows[0];
  expect(review.source_version).toBe(2);
  expect(review.version).toBe(2);
  expect(review.book_snapshot.version).toBe(2);
});
