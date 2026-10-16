import { it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { createLibraryStore } from "../src/server/library-store";
import { collectBookReference } from "../src/local/curation/catalog";
import { createCurationStore } from "../src/server/curation-store";
import { adoptCollectedClassification } from "../src/local/curation/verified-classification";
import {
  classificationBooks,
  parseClassificationIds,
} from "../src/local/curation/classification-selection";
let f: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  f = await testDatabase();
});
afterAll(async () => f.pg.close());
async function setup(owner: string) {
  const library = createLibraryStore(f.db);
  const b = await library.mutate(owner, {
    requestId: randomUUID(),
    type: "addBook",
    payload: {
      title: "정서의 발견",
      isbn: "9780306406157",
      formats: ["paper"],
    },
  });
  await f.db.query(
    "UPDATE library_books SET category='200',classification=$3 WHERE owner_id=$1 AND id=$2",
    [
      owner,
      b.id,
      JSON.stringify({
        code: "200",
        verified: false,
        method: "KDC 큰 분류 제안",
      }),
    ],
  );
  await collectBookReference(
    f.db,
    owner,
    { kind: "book", id: b.id!, version: "1" },
    {
      provider: "도서관 정보나루",
      url: "https://www.data4library.kr",
      isbn: "9780306406157",
      title: "정서의 발견",
      facts: {
        title: "정서의 발견",
        author: "저자",
        publisher: "출판사",
        isbn: "9780306406157",
        coverUrl: "https://images.example.org/book.jpg",
        category: "100",
        classification: {
          source: "국립중앙도서관·도서관 정보나루",
          code: "186.3",
          verified: true,
          method: "ISBN 일치",
          url: "https://www.data4library.kr",
        },
      },
      description: "<주의> 도서관 제공 소개 &quot;표기&quot;",
      descriptionFormat: "plain-text-v1",
    },
    true,
  );
  await library.mutate(owner, {
    requestId: randomUUID(),
    type: "addNote",
    payload: { title: "내 생각", content: "그대로 보관", bookId: b.id },
  });
  await library.mutate(owner, {
    requestId: randomUUID(),
    type: "startReading",
    payload: { bookId: b.id, startedOn: "2026-10-14" },
  });
  return { id: b.id!, library };
}
it("limits incremental classification to requested books of the same owner", async () => {
  const owner = "incremental-classification",
    first = await setup(owner),
    second = await setup(owner);
  const foreign = await setup("incremental-other");
  const ids = parseClassificationIds(first.id + "," + foreign.id);
  expect(
    (await classificationBooks(f.db, owner, ids)).map((b) => b.id),
  ).toEqual([first.id]);
  expect(
    (await classificationBooks(f.db, owner, null)).map((b) => b.id).sort(),
  ).toEqual([first.id, second.id].sort());
  expect(await classificationBooks(f.db, owner, [])).toEqual([]);
  expect(() => parseClassificationIds("")).toThrow();
  expect(() => parseClassificationIds("not-a-uuid")).toThrow();
});
it("adopts an ISBN/title-matched official category while keeping introduction, cover and human records current", async () => {
  const owner = "classification-adopt",
    { id, library } = await setup(owner),
    before = await library.snapshot(owner);
  expect(
    await adoptCollectedClassification(f.db, owner, id, 1, false),
  ).toMatchObject({ ready: true, applied: false, category: "100" });
  expect(await library.snapshot(owner)).toEqual(before);
  expect(
    await adoptCollectedClassification(f.db, owner, id, 1, true),
  ).toMatchObject({ applied: true, version: 2 });
  const after = await library.snapshot(owner);
  expect(after.books[0]).toMatchObject({
    category: "100",
    classification: { code: "186.3", verified: true },
    catalogCoverUrl: "https://images.example.org/book.jpg",
  });
  expect(after.notes).toEqual(before.notes);
  expect(after.cycles).toEqual(before.cycles);
  const current = (
    await createCurationStore(f.db).list(owner, "book", id)
  ).filter((c) => !c.source_stale);
  expect(
    current.some(
      (c) =>
        c.kind === "publisher_intro" &&
        c.value === "<주의> 도서관 제공 소개 &quot;표기&quot;" &&
        c.generator === "도서관 정보나루/plain-text-v1",
    ),
  ).toBe(true);
  expect(
    await adoptCollectedClassification(f.db, owner, id, 2, true),
  ).toMatchObject({ applied: false });
});
it("adopts an official subtitle variant only with matching primary author and publisher", async () => {
  const owner = "classification-subtitle",
    { id } = await setup(owner);
  await f.db.query(
    "UPDATE library_books SET author='저자',publisher='출판사' WHERE id=$1",
    [id],
  );
  await f.db.query(
    "UPDATE library_reference_sources SET facts=jsonb_set(facts,'{title}','\"정서의 발견 :감정을 이해하는 길\"') WHERE owner_id=$1",
    [owner],
  );
  expect(
    await adoptCollectedClassification(f.db, owner, id, 1, false),
  ).toMatchObject({ ready: true });
  expect(
    await adoptCollectedClassification(f.db, owner, id, 1, true),
  ).toMatchObject({ applied: true });
  expect(
    (
      await f.db.query(
        "SELECT title,author,publisher FROM library_books WHERE id=$1",
        [id],
      )
    ).rows[0],
  ).toEqual({ title: "정서의 발견", author: "저자", publisher: "출판사" });
});
it("preserves manual or hidden data and rejects other owners, stale versions and conflicting source facts", async () => {
  for (const mode of [
    "manual",
    "hidden",
    "foreign",
    "stale",
    "conflict",
    "excluded",
  ]) {
    const owner = "classification-" + mode,
      { id } = await setup(owner);
    if (mode === "manual")
      await f.db.query(
        "UPDATE library_books SET classification=$3 WHERE owner_id=$1 AND id=$2",
        [owner, id, JSON.stringify({ method: "manual" })],
      );
    if (mode === "hidden") {
      const item = (await createCurationStore(f.db).list(owner, "book", id))[0];
      await createCurationStore(f.db).edit(owner, item.id, 1, {
        value: item.value,
        state: "hidden",
      });
    }
    if (mode === "conflict")
      await f.db.query(
        "UPDATE library_reference_sources SET facts=jsonb_set(facts,'{isbn}','\"9780140449136\"') WHERE owner_id=$1",
        [owner],
      );
    if (mode === "excluded")
      await f.db.query(
        "UPDATE library_books SET source_data=$3 WHERE owner_id=$1 AND id=$2",
        [
          owner,
          id,
          JSON.stringify({ app: "Local PDF", recordId: randomUUID() }),
        ],
      );
    expect(
      await adoptCollectedClassification(
        f.db,
        mode === "foreign" ? "other" : owner,
        id,
        mode === "stale" ? 2 : 1,
        true,
      ),
    ).toMatchObject({ applied: false });
    expect(
      (
        await f.db.query(
          "SELECT category,version FROM library_books WHERE id=$1",
          [id],
        )
      ).rows[0],
    ).toMatchObject({ category: "200", version: 1 });
  }
});
it("rolls back the category if new-version auxiliary storage fails and safely retries", async () => {
  const owner = "classification-atomic",
    { id } = await setup(owner);
  const failing: typeof f.db = {
    query: f.db.query,
    transaction: (fn) =>
      f.db.transaction((tx) =>
        fn({
          query: (sql, args) => {
            if (sql.startsWith("INSERT INTO library_reference_sources"))
              throw Error("storage failed");
            return tx.query(sql, args);
          },
        }),
      ),
  };
  await expect(
    adoptCollectedClassification(failing, owner, id, 1, true),
  ).rejects.toThrow("storage failed");
  expect(
    (
      await f.db.query(
        "SELECT category,version FROM library_books WHERE id=$1",
        [id],
      )
    ).rows[0],
  ).toMatchObject({ category: "200", version: 1 });
  expect(
    await adoptCollectedClassification(f.db, owner, id, 1, true),
  ).toMatchObject({ applied: true });
});
