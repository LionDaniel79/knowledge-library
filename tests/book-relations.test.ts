import { it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { createLibraryStore } from "../src/server/library-store";
import { createBookRelationStore } from "../src/server/book-relations";
import {
  bookDuplicateCandidates,
  sameBookFiles,
} from "../src/server/book-duplicates";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, writeFileSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
let f: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  f = await testDatabase();
});
afterAll(async () => f.pg.close());
it("verifies duplicate file signatures locally and filters candidate ownership", async () => {
  const temp = mkdtempSync(join(tmpdir(), "library-dups-")),
    oldIndex = process.env.LIBRARY_PDF_INDEX,
    oldRoot = process.env.LIBRARY_PDF_ROOT;
  try {
    const index = new DatabaseSync(join(temp, "index.sqlite"));
    index.exec(
      "CREATE TABLE documents(id TEXT,path TEXT,signature TEXT,sha256 TEXT,status TEXT)",
    );
    const l = createLibraryStore(f.db),
      ids: string[] = [];
    const hash = createHash("sha256").update("%PDF-test").digest("hex");
    for (let i = 0; i < 3; i++) {
      const owner = i === 2 ? "outsider" : "file-owner",
        b = await l.mutate(owner, {
          requestId: randomUUID(),
          type: "addBook",
          payload: { title: `파일 ${i}`, formats: ["pdf"] },
        }),
        id = randomUUID(),
        path = join(temp, `${i}.pdf`);
      ids.push(b.id!);
      writeFileSync(path, "%PDF-test");
      const s = statSync(path, { bigint: true });
      index
        .prepare("INSERT INTO documents VALUES(?,?,?,?,?)")
        .run(id, path, `${s.size}:${s.mtimeNs}`, hash, "ready");
      await f.db.query(
        "INSERT INTO library_documents(id,owner_id,book_id,root,path,relative_path,bytes,mtime_ns) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          id,
          owner,
          b.id,
          temp,
          path,
          `${i}.pdf`,
          String(s.size),
          String(s.mtimeNs),
        ],
      );
    }
    index.close();
    process.env.LIBRARY_PDF_INDEX = join(temp, "index.sqlite");
    process.env.LIBRARY_PDF_ROOT = temp;
    const found = await bookDuplicateCandidates(f.db, "file-owner", ids[0]);
    expect(found.candidates.map((c) => c.id)).toEqual([ids[1]]);
    expect(
      await sameBookFiles(f.db, "file-owner", ids[0], ids[1]),
    ).toMatchObject({ sha256: hash });
    expect(await sameBookFiles(f.db, "file-owner", ids[0], ids[2])).toBeNull();
    const relations = createBookRelationStore(f.db, (a, b, tx) =>
      sameBookFiles(tx, "file-owner", a, b),
    );
    await relations.mutate("file-owner", {
      requestId: randomUUID(),
      leftId: ids[0],
      rightId: ids[1],
      leftVersion: 1,
      rightVersion: 1,
      relation: "same_file",
      state: "accepted",
      reason: "해시 확인",
      expectedVersion: 0,
    });
    expect((await relations.list("file-owner", ids[0]))[0].freshness).toBe(
      "current",
    );
    expect(
      (await createBookRelationStore(f.db).list("file-owner", ids[0]))[0]
        .freshness,
    ).toBe("unavailable");
    writeFileSync(join(temp, "1.pdf"), "changed original");
    expect(await sameBookFiles(f.db, "file-owner", ids[0], ids[1])).toBeNull();
    expect(
      (await bookDuplicateCandidates(f.db, "file-owner", ids[0])).candidates,
    ).toEqual([]);
    expect((await relations.list("file-owner", ids[0]))[0].freshness).toBe(
      "unavailable",
    );
    await f.db.query(
      "UPDATE library_documents SET mtime_ns='changed' WHERE owner_id=$1 AND book_id=$2",
      ["file-owner", ids[1]],
    );
    expect((await relations.list("file-owner", ids[0]))[0]).toMatchObject({
      state: "accepted",
      freshness: "stale",
    });
  } finally {
    if (oldIndex === undefined) delete process.env.LIBRARY_PDF_INDEX;
    else process.env.LIBRARY_PDF_INDEX = oldIndex;
    if (oldRoot === undefined) delete process.env.LIBRARY_PDF_ROOT;
    else process.env.LIBRARY_PDF_ROOT = oldRoot;
    rmSync(temp, { recursive: true });
  }
});
it("links and withdraws edition relationships without merging records; protects versions and owners", async () => {
  const owner = "relations",
    l = createLibraryStore(f.db),
    store = createBookRelationStore(f.db);
  const books = [];
  for (const title of ["종이책", "PDF"])
    books.push(
      await l.mutate(owner, {
        requestId: randomUUID(),
        type: "addBook",
        payload: { title, formats: ["paper"] },
      }),
    );
  const before = await l.snapshot(owner);
  const input = {
    requestId: randomUUID(),
    leftId: books[0].id,
    rightId: books[1].id,
    leftVersion: 1,
    rightVersion: 1,
    relation: "same_edition",
    state: "accepted",
    reason: "ISBN과 판권면을 직접 대조함",
    expectedVersion: 0,
  };
  const result = await store.mutate(owner, input);
  expect(await store.mutate(owner, input)).toEqual(result);
  expect(await l.snapshot(owner)).toEqual(before);
  expect(await store.list(owner, books[0].id!)).toEqual([
    expect.objectContaining({
      state: "accepted",
      relation: "same_edition",
      version: 1,
    }),
  ]);
  expect(await store.list("other", books[0].id!)).toEqual([]);
  expect((await store.list(owner, books[0].id!))[0].freshness).toBe("current");
  await f.db.query(
    "UPDATE library_books SET isbn='9780140449136',version=2 WHERE owner_id=$1 AND id=$2",
    [owner, books[1].id],
  );
  expect((await store.list(owner, books[0].id!))[0]).toMatchObject({
    state: "accepted",
    freshness: "stale",
  });
  await expect(
    store.mutate("other", { ...input, requestId: randomUUID() }),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    store.mutate(owner, { ...input, requestId: randomUUID(), leftVersion: 99 }),
  ).rejects.toMatchObject({ status: 409 });
  await store.mutate(owner, {
    ...input,
    requestId: randomUUID(),
    leftId: books[1].id,
    rightId: books[0].id,
    leftVersion: 2,
    expectedVersion: 1,
    state: "withdrawn",
    reason: "판본이 달랐음",
  });
  expect((await store.list(owner, books[0].id!))[0]).toMatchObject({
    state: "withdrawn",
    version: 2,
  });
  expect(
    (
      await f.db.query(
        "SELECT * FROM library_revisions WHERE owner_id=$1 AND action='bookRelation'",
        [owner],
      )
    ).rows,
  ).toHaveLength(2);
});
it("requires server-verified file equality and ignores a forged client hash", async () => {
  const owner = "file-relation",
    l = createLibraryStore(f.db),
    ids = [];
  for (let i = 0; i < 2; i++)
    ids.push(
      (
        await l.mutate(owner, {
          requestId: randomUUID(),
          type: "addBook",
          payload: { title: `PDF${i}`, formats: ["pdf"] },
        })
      ).id!,
    );
  const input = {
    requestId: randomUUID(),
    leftId: ids[0],
    rightId: ids[1],
    leftVersion: 1,
    rightVersion: 1,
    relation: "same_file",
    state: "accepted",
    reason: "파일 동일",
    expectedVersion: 0,
    evidence: { sha256: "forged" },
  };
  await expect(
    createBookRelationStore(f.db).mutate(owner, input),
  ).rejects.toMatchObject({ status: 409 });
  const store = createBookRelationStore(f.db, async () => ({
    sha256: "a".repeat(64),
    method: "sha256",
    verifiedAt: "2026-10-14T00:00:00Z",
  }));
  await store.mutate(owner, input);
  expect((await store.list(owner, ids[0]))[0].evidence.file.sha256).toBe(
    "a".repeat(64),
  );
});
