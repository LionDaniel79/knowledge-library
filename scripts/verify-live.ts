import { createThoughtMapStore } from "../src/server/thought-map-store";
import {
  createThoughtJobStore,
  sourceVersion,
} from "../src/server/thought-job-store";
import { Pool } from "pg";
import { dateOnlyTypes } from "../src/server/pg-types";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { createLibraryStore, type Database } from "../src/server/library-store";
if (!process.env.DATABASE_URL) throw Error("DATABASE_URL required");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  types: dateOnlyTypes,
});
const client = await pool.connect();
const owner = "rollback-check-" + randomUUID();
try {
  const role = (await client.query("SELECT current_user AS role")).rows[0].role;
  const permissions = (
    await client.query(
      "SELECT has_table_privilege(current_user,'library_books','INSERT') AS can_write, has_schema_privilege(current_user,'public','CREATE') AS can_create",
    )
  ).rows[0];
  assert.equal(permissions.can_write, true);
  assert.equal(permissions.can_create, false);
  await client.query("BEGIN");
  // Exercise the real store on one connection; the enclosing transaction is always rolled back.
  const db: Database = {
    query: (sql, params = []) => client.query(sql, params),
    transaction: (fn) =>
      fn({ query: (sql, params = []) => client.query(sql, params) }),
  };
  const store = createLibraryStore(db);
  const cmd = (type: string, payload: unknown) => ({
    requestId: randomUUID(),
    type,
    payload,
  });
  const add = cmd("addBook", {
    title: "연결 검증용 임시 책",
    formats: ["paper", "pdf"],
    totalPages: 200,
  });
  const book = await store.mutate(owner, add);
  assert.deepEqual(await store.mutate(owner, add), book);
  await store.mutate(owner, cmd("createShelf", { name: "검증 책장" }));
  await store.mutate(
    owner,
    cmd("editBook", {
      id: book.id,
      expectedVersion: 1,
      title: "연결 검증용 임시 책",
      formats: ["paper", "pdf"],
      totalPages: 200,
      category: "100",
      bookshelves: ["책 대기열", "검증 책장"],
    }),
  );
  const edited = (
    await client.query(
      "SELECT category,bookshelves,version FROM library_books WHERE owner_id=$1 AND id=$2",
      [owner, book.id],
    )
  ).rows[0];
  assert.equal(edited.category, "100");
  assert.deepEqual(edited.bookshelves, ["책 대기열", "검증 책장"]);
  assert.equal(edited.version, 2);
  const cycle = await store.mutate(
    owner,
    cmd("startReading", { bookId: book.id, startedOn: "2026-09-01" }),
  );
  await store.mutate(
    owner,
    cmd("completeReading", {
      id: cycle.id,
      expectedVersion: 1,
      completedOn: "2026-10-01",
    }),
  );
  await store.mutate(
    owner,
    cmd("editCompletion", {
      id: cycle.id,
      expectedVersion: 2,
      completedOn: "2026-09-30",
    }),
  );
  await store.mutate(
    owner,
    cmd("startReading", { bookId: book.id, startedOn: "2026-10-02" }),
  );
  const note = await store.mutate(
    owner,
    cmd("addNote", {
      bookId: book.id,
      title: "메모 검증",
      content: "처음 생각",
      kind: "note",
      page: 12,
    }),
  );
  await store.mutate(
    owner,
    cmd("editNote", {
      id: note.id,
      expectedVersion: 1,
      bookId: book.id,
      title: "메모 검증",
      content: "수정한 생각",
      tags: ["검증", "성찰"],
      kind: "note",
      page: 12,
    }),
  );
  assert.equal((await store.revisions(owner, note.id)).length, 2);
  assert.equal(
    (
      await client.query(
        "SELECT count(*)::int AS n FROM library_cycles WHERE owner_id=$1",
        [owner],
      )
    ).rows[0].n,
    2,
  );
  assert.equal((await store.revisions(owner + "other", note.id)).length, 0);
  const thoughts = createThoughtMapStore(db),
    jobs = createThoughtJobStore(db);
  await thoughts.mutate(
    owner,
    cmd("setThoughtEvent", {
      noteId: note.id,
      expectedVersion: 0,
      occurredOn: "2020-01-01",
      voice: "self",
    }),
  );
  const topic = await thoughts.mutate(
    owner,
    cmd("upsertTopic", {
      name: "검수용 주제",
      parentId: null,
      aliases: [],
      description: "롤백되는 검사",
      kdcCodes: [],
    }),
  );
  await thoughts.mutate(
    owner,
    cmd("assignTopic", {
      topicId: topic.id,
      sourceKind: "note",
      sourceId: note.id,
      sourceVersion: "2",
      status: "accepted",
    }),
  );
  const input = {
    kind: "compare" as const,
    sourceId: note.id,
    sourceVersion: await sourceVersion(db, owner, note.id),
    modelDigest: "rollback-test",
    promptVersion: "1",
    retrievalVersion: "1",
    priority: 1 as const,
  };
  const jobId = await jobs.enqueue(db, owner, input);
  assert.equal(await jobs.enqueue(db, owner, input), jobId);
  const now = new Date(),
    job = await jobs.claim(owner, "rollback-worker", now, input);
  assert.equal(job?.id, jobId);
  assert.equal(await jobs.renew(owner, jobId, job!.leaseToken!, now), true);
  const sourcePage = await jobs.sourcePage(
    owner,
    jobId,
    job!.leaseToken!,
    { kind: "notes" },
    now,
  );
  assert.equal(
    sourcePage.items.some((n) => n.id === note.id),
    true,
  );
  const metadata = await jobs.sourcePage(
    owner,
    jobId,
    job!.leaseToken!,
    { kind: "books" },
    now,
  );
  assert.equal(
    metadata.items.some((b) => b.id === book.id),
    true,
  );
  await jobs.finish(
    owner,
    jobId,
    job!.leaseToken!,
    { candidateInputs: [], indexStatus: "ready" },
    now,
  );
  assert.equal((await jobs.status(owner)).lastResultAt !== null, true);
  await client.query("ROLLBACK");
  assert.equal(
    (
      await client.query(
        "SELECT count(*)::int AS n FROM library_books WHERE owner_id=$1",
        [owner],
      )
    ).rows[0].n,
    0,
  );
  console.log(
    "PASS: live Neon " +
      role +
      " permissions, book, idempotency, reread, date edit, note history and isolation. All test records rolled back.",
  );
} catch (e) {
  await client.query("ROLLBACK");
  console.error(
    "Live check failed:",
    e instanceof Error ? e.message : "Unknown",
  );
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
