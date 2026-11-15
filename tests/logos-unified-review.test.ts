import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { createLibraryStore } from "../src/server/library-store";
import {
  readCatalogReviews,
  decideCatalogReview,
} from "../src/server/catalog-review-store";
import { storedCandidateKey } from "../src/lib/catalog-review";
let f: Awaited<ReturnType<typeof testDatabase>>;
const gate = process.env.LIBRARY_STAGE5_WRITE_ENABLED;
beforeAll(async () => {
  f = await testDatabase();
  process.env.LIBRARY_STAGE5_WRITE_ENABLED = "true";
});
afterAll(async () => {
  await f.pg.close();
  if (gate === undefined) delete process.env.LIBRARY_STAGE5_WRITE_ENABLED;
  else process.env.LIBRARY_STAGE5_WRITE_ENABLED = gate;
});
const record = {
  provider: "예스24",
  url: "https://www.yes24.com/product/goods/1234",
  isbn: "",
  title: "제목으로만 찾은 후보",
  facts: {
    title: "후보 제목",
    author: "후보 저자",
    publisher: "후보 출판사",
    isbn: "",
    coverUrl: "",
  },
  description: "후보 소개",
  toc: ["1장", "2장"],
};
async function fixture(records: any[] = [record]) {
  const owner = randomUUID();
  const added = await createLibraryStore(f.db).mutate(owner, {
    type: "addBook",
    requestId: randomUUID(),
    payload: {
      title: "기존 제목",
      author: "기존 저자",
      formats: ["logos"],
      tags: [],
    },
  });
  await f.db.query(
    "UPDATE library_books SET source_data=$3,enrichment=$4 WHERE owner_id=$1 AND id=$2",
    [
      owner,
      added.id,
      JSON.stringify({ app: "Logos", recordId: "LLS:TEST", raw: {} }),
      JSON.stringify({
        logosCompletion: { state: "review", candidates: records },
        auto_toc: ["기존 목차"],
      }),
    ],
  );
  return { owner, id: added.id! };
}
async function first(x: { owner: string }) {
  const page = await readCatalogReviews(f.db, x.owner, {
    format: "logos",
    inline: "1",
    groupBy: "book",
  });
  expect(page.total).toBe(1);
  expect(page.items![0].alternatives.length).toBeGreaterThan(0);
  return page.items![0].alternatives[0];
}
it("hydrates legacy Logos candidates with canonical keys and applies only selected fields without ISBN", async () => {
  const x = await fixture();
  const c = await first(x);
  expect(c.candidateKey).toBe(storedCandidateKey(record));
  expect(c.current.toc).toEqual(["기존 목차"]);
  const body = {
    id: c.id,
    candidateKey: c.candidateKey,
    expectedVersion: c.version,
    requestId: randomUUID(),
    action: "apply",
    fields: ["description"],
    sameEdition: true,
  };
  await decideCatalogReview(f.db, x.owner, body);
  await decideCatalogReview(f.db, x.owner, body);
  const b = (
    await f.db.query("SELECT * FROM library_books WHERE id=$1", [x.id])
  ).rows[0];
  expect(b.version).toBe(2);
  expect(b.title).toBe("기존 제목");
  expect(b.author).toBe("기존 저자");
  expect(b.enrichment.auto_description).toBe("후보 소개");
  expect(b.enrichment.auto_toc).toEqual(["기존 목차"]);
  expect(b.enrichment.logosCompletion.candidates).toHaveLength(1);
  expect(
    (await readCatalogReviews(f.db, x.owner, { format: "logos" })).total,
  ).toBe(0);
});
it("rejects every alternative in a selected book row, keeps books and remembers fingerprints", async () => {
  const x = await fixture([
    record,
    {
      ...record,
      url: "https://www.yes24.com/product/goods/5678",
      title: "두 번째 후보",
    },
  ]);
  const c = await first(x);
  const body = {
    id: c.id,
    candidateKey: c.candidateKey,
    expectedVersion: c.version,
    requestId: randomUUID(),
    action: "reject",
    rejectAll: true,
  };
  await decideCatalogReview(f.db, x.owner, body);
  await decideCatalogReview(f.db, x.owner, body);
  expect(
    (await readCatalogReviews(f.db, x.owner, { format: "logos" })).total,
  ).toBe(0);
  expect(
    (
      await readCatalogReviews(f.db, x.owner, {
        format: "logos",
        status: "rejected",
      })
    ).items![0].alternatives,
  ).toHaveLength(2);
  const b = (
    await f.db.query("SELECT * FROM library_books WHERE id=$1", [x.id])
  ).rows[0];
  expect(b.enrichment.rejectedBibliography).toHaveLength(2);
  expect(b.title).toBe("기존 제목");
  expect(b.version).toBe(2);
});
it("isolates owners and guards stale, unknown candidates, protected fields and the write gate", async () => {
  const x = await fixture();
  const c = await first(x);
  const body = {
    id: c.id,
    candidateKey: c.candidateKey,
    expectedVersion: c.version,
    requestId: randomUUID(),
    action: "apply",
    fields: ["author"],
    sameEdition: true,
  };
  await expect(decideCatalogReview(f.db, randomUUID(), body)).rejects.toThrow();
  await expect(
    decideCatalogReview(f.db, x.owner, { ...body, expectedVersion: 2 }),
  ).rejects.toThrow();
  await expect(
    decideCatalogReview(f.db, x.owner, { ...body, candidateKey: "invented" }),
  ).rejects.toThrow();
  await f.db.query(
    "UPDATE library_books SET enrichment=enrichment || $2::jsonb WHERE id=$1",
    [x.id, JSON.stringify({ autoBibliographyLocks: ["author"] })],
  );
  await expect(decideCatalogReview(f.db, x.owner, body)).rejects.toThrow(
    "보호",
  );
  process.env.LIBRARY_STAGE5_WRITE_ENABLED = "false";
  await expect(decideCatalogReview(f.db, x.owner, body)).rejects.toThrow(
    "허용",
  );
  process.env.LIBRARY_STAGE5_WRITE_ENABLED = "true";
});
it("paginates and searches ISBN-less candidates without dropping full comparison payloads", async () => {
  const x = await fixture([record]);
  await createLibraryStore(f.db).mutate(x.owner, {
    type: "addBook",
    requestId: randomUUID(),
    payload: { title: "후보 없는 Logos", formats: ["logos"] },
  });
  const page = await readCatalogReviews(f.db, x.owner, {
    format: "logos",
    q: "제목으로만",
    limit: 1,
  });
  expect(page.total).toBe(1);
  expect(page.items![0].alternatives[0].record.description).toBe(
    record.description,
  );
  expect(page.items![0].alternatives[0].record.toc).toEqual(record.toc);
  expect(
    (
      await readCatalogReviews(f.db, x.owner, {
        format: "logos",
        offset: 1,
        limit: 1,
      })
    ).items,
  ).toHaveLength(0);
});
for (const source of ["table", "stored"])
  it(`rejects every mixed-source candidate when choosing a ${source} row`, async () => {
    const x = await fixture([
      record,
      { ...record, url: "https://www.yes24.com/product/goods/999" },
    ]);
    const id = randomUUID();
    await f.db.query(
      "INSERT INTO library_catalog_reviews(id,owner_id,book_id,source_version,book_snapshot,record,fingerprint) VALUES($1,$2,$3,1,'{}',$4,'mixed')",
      [
        id,
        x.owner,
        x.id,
        JSON.stringify({
          ...record,
          url: "https://www.yes24.com/product/goods/777",
        }),
      ],
    );
    const body: any = {
      id,
      expectedVersion: 1,
      requestId: randomUUID(),
      action: "reject",
      rejectAll: true,
    };
    if (source === "stored") {
      body.id = x.id;
      body.candidateKey = storedCandidateKey(record);
    }
    await decideCatalogReview(f.db, x.owner, body);
    await decideCatalogReview(f.db, x.owner, body);
    expect(
      (await readCatalogReviews(f.db, x.owner, { format: "logos" })).total,
    ).toBe(0);
    expect(
      (
        await f.db.query(
          "SELECT status FROM library_catalog_reviews WHERE id=$1",
          [id],
        )
      ).rows[0].status,
    ).toBe("rejected");
    expect(
      (
        await f.db.query(
          "SELECT count(*)::int AS n FROM library_books WHERE id=$1",
          [x.id],
        )
      ).rows[0].n,
    ).toBe(1);
  });
