import { it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { createLibraryStore } from "../src/server/library-store";
import { applyPdfIdentity } from "../src/local/curation/pdf-identity-store";
import {
  extractPdfIdentity,
  type PdfIdentity,
} from "../src/local/curation/pdf-identity";
import type { CollectedBook } from "../src/local/curation/catalog";
let fixture: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  fixture = await testDatabase();
});
afterAll(async () => fixture?.pg.close());
const record: CollectedBook = {
  provider: "도서관 정보나루",
  url: "https://www.data4library.kr",
  isbn: "9780306406157",
  title: "마음의 이해",
  facts: {
    title: "마음의 이해",
    isbn: "9780306406157",
    author: "홍길동",
    publisher: "출판사",
    coverUrl: "",
  },
};
async function setup(owner: string) {
  const lib = createLibraryStore(fixture.db);
  const b = await lib.mutate(owner, {
    requestId: randomUUID(),
    type: "addBook",
    payload: { title: "마음의 이해", formats: ["pdf"] },
  });
  const documentId = randomUUID();
  await fixture.db.query(
    "UPDATE library_books SET source_data=$3 WHERE owner_id=$1 AND id=$2",
    [owner, b.id, JSON.stringify({ app: "Local PDF", recordId: documentId })],
  );
  await fixture.db.query(
    "INSERT INTO library_documents(id,owner_id,book_id,root,path,relative_path,bytes,mtime_ns,processing_scope) VALUES($1,$2,$3,'E:/books',$4,'book.pdf',100,'1','full')",
    [documentId, owner, b.id, `E:/books/${documentId}.pdf`],
  );
  const evidence = extractPdfIdentity(
    {
      id: documentId,
      title: "마음의 이해",
      author: "",
      signature: "sig",
      sha256: "hash",
      pageCount: 100,
      processingScope: "full",
      status: "ready",
    },
    Array.from({ length: 100 }, (_, i) => i + 1)
      .filter((n) => n <= 12 || n > 92)
      .map((n) => ({
        pageNumber: n,
        text: n === 100 ? "ISBN 9780306406157" : "",
        method: n === 100 ? "text" : "ocr_empty",
      })),
  );
  return { id: b.id!, evidence };
}
it("fills only blank bibliographic fields, records full before/after history and is idempotent", async () => {
  const { id, evidence } = await setup("identity");
  await fixture.db.query(
    "UPDATE library_books SET publisher='출판사 ',tags=ARRAY['내 태그'] WHERE owner_id=$1 AND id=$2",
    ["identity", id],
  );
  const result = await applyPdfIdentity(
    fixture.db,
    "identity",
    id,
    1,
    evidence,
    record,
    () => true,
  );
  expect(result).toMatchObject({ applied: true, version: 2 });
  const row = (
    await fixture.db.query(
      "SELECT * FROM library_books WHERE owner_id=$1 AND id=$2",
      ["identity", id],
    )
  ).rows[0];
  expect(row).toMatchObject({
    isbn: record.isbn,
    author: "홍길동",
    publisher: "출판사 ",
    title: "마음의 이해",
    tags: ["내 태그"],
  });
  expect(row.enrichment.pdfIdentity.evidence[0].pageNumber).toBe(100);
  const history = (
    await fixture.db.query(
      "SELECT * FROM library_revisions WHERE owner_id=$1 AND action='identifyPdfEdition'",
      ["identity"],
    )
  ).rows;
  expect(history).toHaveLength(1);
  expect(history[0].before_data.isbn).toBe("");
  expect(history[0].after_data.isbn).toBe(record.isbn);
  expect(
    (
      await applyPdfIdentity(
        fixture.db,
        "identity",
        id,
        2,
        evidence,
        record,
        () => true,
      )
    ).applied,
  ).toBe(false);
});
it("rolls back identity on provider-enrichment failure, then retries both together", async () => {
  const { id, evidence } = await setup("atomic");
  const failingDb: typeof fixture.db = {
    query: fixture.db.query,
    transaction: (fn) =>
      fixture.db.transaction((tx) =>
        fn({
          query: (sql, values) => {
            if (sql.startsWith("INSERT INTO library_reference_sources"))
              throw Error("simulated storage interruption");
            return tx.query(sql, values);
          },
        }),
      ),
  };
  await expect(
    applyPdfIdentity(failingDb, "atomic", id, 1, evidence, record, () => true),
  ).rejects.toThrow("simulated storage interruption");
  expect(
    (
      await fixture.db.query(
        "SELECT isbn,version FROM library_books WHERE owner_id='atomic' AND id=$1",
        [id],
      )
    ).rows[0],
  ).toMatchObject({ isbn: "", version: 1 });
  expect(
    (
      await fixture.db.query(
        "SELECT id FROM library_revisions WHERE owner_id='atomic' AND action='identifyPdfEdition'",
      )
    ).rows,
  ).toHaveLength(0);
  await expect(
    applyPdfIdentity(fixture.db, "atomic", id, 1, evidence, record, () => true),
  ).resolves.toMatchObject({ applied: true, version: 2 });
  expect(
    (
      await fixture.db.query(
        "SELECT value FROM library_curation_items WHERE owner_id='atomic' AND source_id=$1 AND source_version='2' AND kind='bibliography' AND state='active'",
        [id],
      )
    ).rows[0]?.value.isbn,
  ).toBe(record.isbn);
});
it("rejects wrong owner, stale version, changed source, user edits, excluded scope and title-only evidence", async () => {
  const { id, evidence } = await setup("guard");
  const attempts: [string, number, PdfIdentity, () => boolean][] = [
    ["other", 1, evidence, () => true],
    ["guard", 2, evidence, () => true],
    ["guard", 1, evidence, () => false],
    ["guard", 1, { ...evidence, candidates: [] }, () => true],
  ];
  for (const args of attempts) {
    expect(
      (
        await applyPdfIdentity(
          fixture.db,
          args[0],
          id,
          args[1],
          args[2],
          record,
          args[3],
        )
      ).applied,
    ).toBe(false);
  }
  await fixture.db.query(
    "UPDATE library_documents SET processing_scope='metadata_only' WHERE owner_id=$1 AND book_id=$2",
    ["guard", id],
  );
  expect(
    (
      await applyPdfIdentity(
        fixture.db,
        "guard",
        id,
        1,
        evidence,
        record,
        () => true,
      )
    ).applied,
  ).toBe(false);
  await fixture.db.query(
    "UPDATE library_documents SET processing_scope='full' WHERE owner_id=$1 AND book_id=$2",
    ["guard", id],
  );
  await fixture.db.query(
    "INSERT INTO library_revisions(id,owner_id,entity_id,action,after_data) VALUES($1,'guard',$2,'editBook','{}')",
    [randomUUID(), id],
  );
  expect(
    (
      await applyPdfIdentity(
        fixture.db,
        "guard",
        id,
        1,
        evidence,
        record,
        () => true,
      )
    ).applied,
  ).toBe(false);
  expect(
    (
      await fixture.db.query(
        "SELECT isbn,version FROM library_books WHERE owner_id='guard' AND id=$1",
        [id],
      )
    ).rows[0],
  ).toMatchObject({ isbn: "", version: 1 });
});
