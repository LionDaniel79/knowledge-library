import { afterAll, beforeAll, expect, it } from "vitest";
import { testDatabase } from "./helpers/database";
import { createLibraryStore } from "../src/server/library-store";
import { bootstrapReplica } from "../src/client/replica/bootstrap";
import { createMemoryReplica } from "../src/client/replica/memory-storage";
import { createReplicaRepository } from "../src/client/replica/repository";
import { queueReplicaCommand } from "../src/client/replica/outbox";
import { createLibraryRuntime } from "../src/client/replica/runtime";
import { projectLibrarySave } from "../src/client/replica/save-projection";
import { sqlSyncTransport } from "./helpers/sync-transport";
import { executeSyncCommand } from "../src/server/sync/commands";
import { pushReplica } from "../src/client/replica/push";
import { pullReplica } from "../src/client/replica/pull";
import type { QueuedChange } from "../src/client/replica/optimistic";

let f: Awaited<ReturnType<typeof testDatabase>>;
let store: ReturnType<typeof createLibraryStore>;
const command = (type: string, payload: unknown) => ({
  requestId: crypto.randomUUID(),
  type,
  payload,
});
const shelves = ["책 대기열", "내 인생 최고의 책들"];
beforeAll(async () => {
  f = await testDatabase();
  store = createLibraryStore(f.db);
});
afterAll(async () => {
  await f?.pg.close();
});

it("atomically removes only the queue membership while preserving the book and completed history", async () => {
  const owner = "start-queue";
  const book = await store.mutate(
    owner,
    command("addBook", {
      title: "보존할 책",
      formats: ["paper"],
      bookshelves: shelves,
    }),
  );
  const oldCycle = await store.mutate(
    owner,
    command("startReading", { bookId: book.id }),
  );
  await store.mutate(
    owner,
    command("completeReading", {
      id: oldCycle.id,
      expectedVersion: 1,
      completedOn: "2026-11-01",
    }),
  );
  const beforeRequeue = (await store.snapshot(owner)).books[0];
  await store.mutate(
    owner,
    command("editBook", {
      ...beforeRequeue,
      expectedVersion: beforeRequeue.version,
      bookshelves: shelves,
    }),
  );
  const before = await store.snapshot(owner);
  const start = command("startReading", {
    bookId: book.id,
    startedOn: "2026-11-11",
  });
  const result = await store.mutate(owner, start);
  const saved = await store.snapshot(owner);
  expect(saved.books).toEqual([
    {
      ...before.books[0],
      bookshelves: ["내 인생 최고의 책들"],
      version: before.books[0].version + 1,
    },
  ]);
  expect(saved.cycles.find((c) => c.id === oldCycle.id)).toEqual(
    before.cycles[0],
  );
  expect(saved.cycles.filter((c) => c.status === "reading")).toHaveLength(1);
  expect(result).toMatchObject({
    book: {
      id: book.id,
      version: before.books[0].version + 1,
      bookshelves: ["내 인생 최고의 책들"],
    },
  });
  const history = await store.revisions(owner, book.id);
  expect(history.at(-1)).toMatchObject({
    action: "startReading",
    before: before.books[0],
    after: saved.books[0],
  });
  expect(await store.mutate(owner, start)).toEqual(result);
  expect(await store.snapshot(owner)).toEqual(saved);
  expect(await store.revisions(owner, book.id)).toEqual(history);
});

it("rolls back queue removal on a cycle conflict and retries do not remove a subsequently re-added queue membership", async () => {
  const owner = "start-rollback";
  const book = await store.mutate(
    owner,
    command("addBook", {
      title: "재시도",
      formats: ["paper"],
      bookshelves: shelves,
    }),
  );
  const start = command("startReading", { bookId: book.id });
  const first = await store.mutate(owner, start);
  const read = (await store.snapshot(owner)).books[0];
  await store.mutate(
    owner,
    command("editBook", {
      ...read,
      expectedVersion: read.version,
      bookshelves: shelves,
    }),
  );
  const requeued = await store.snapshot(owner);
  await expect(
    store.mutate(owner, command("startReading", { bookId: book.id })),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    store.mutate("outsider", command("startReading", { bookId: book.id })),
  ).rejects.toMatchObject({ status: 404 });
  expect(await store.snapshot(owner)).toEqual(requeued);
  expect(await store.mutate(owner, start)).toEqual(first);
  expect(await store.snapshot(owner)).toEqual(requeued);
});

it("keeps nonqueued book versions unchanged when starting", async () => {
  const owner = "start-no-queue";
  const book = await store.mutate(
    owner,
    command("addBook", {
      title: "바로 읽기",
      formats: ["paper"],
      bookshelves: ["내 인생 최고의 책들"],
    }),
  );
  const before = (await store.snapshot(owner)).books;
  await store.mutate(owner, command("startReading", { bookId: book.id }));
  expect((await store.snapshot(owner)).books).toEqual(before);
});

it("rolls back the book, cycle and receipt together when acknowledging the transaction fails", async () => {
  const owner = "start-write-failure";
  const book = await store.mutate(
    owner,
    command("addBook", {
      title: "실패 복구",
      formats: ["paper"],
      bookshelves: shelves,
    }),
  );
  const before = await store.snapshot(owner);
  const revisions = await store.revisions(owner, book.id);
  const start = command("startReading", { bookId: book.id });
  const failing = createLibraryStore({
    query: f.db.query,
    transaction: (fn) =>
      f.db.transaction((tx) =>
        fn({
          query: async (sql, params) => {
            if (sql.startsWith("UPDATE library_operations SET result"))
              throw Error("connection interrupted");
            return tx.query(sql, params);
          },
        }),
      ),
  });
  await expect(failing.mutate(owner, start)).rejects.toThrow(
    "connection interrupted",
  );
  expect(await store.snapshot(owner)).toEqual(before);
  expect(await store.revisions(owner, book.id)).toEqual(revisions);
  await store.mutate(owner, start);
  const saved = await store.snapshot(owner);
  expect(saved.books[0].bookshelves).toEqual(["내 인생 최고의 책들"]);
  expect(saved.cycles).toHaveLength(1);
});

it("retries a lost sync response before a dependent book edit without duplicate cycles or stale versions", async () => {
  const owner = "start-lost-response";
  const book = await store.mutate(
    owner,
    command("addBook", {
      title: "전송 복구",
      formats: ["paper"],
      bookshelves: shelves,
    }),
  );
  const storage = createMemoryReplica(owner),
    transport = sqlSyncTransport(f.db, owner);
  await bootstrapReplica({ owner, storage, transport });
  const repo = createReplicaRepository(storage);
  try {
    const start = command("startReading", { bookId: book.id });
    await queueReplicaCommand({
      storage,
      repository: repo,
      path: "/api/library",
      body: start,
    });
    await queueReplicaCommand({
      storage,
      repository: repo,
      path: "/api/library",
      body: command("editBook", {
        ...(await store.snapshot(owner)).books[0],
        expectedVersion: 2,
        title: "읽으며 고친 제목",
        bookshelves: ["내 인생 최고의 책들"],
      }),
    });
    const send = (entry: any) =>
      executeSyncCommand(f.db, owner, {
        requestId: entry.requestId,
        family: entry.family,
        body: entry.command.body,
      });
    const pull = () =>
      pullReplica({ owner, storage, transport }).then(() => {});
    await expect(
      pushReplica({
        storage,
        pull,
        send: async (entry) => {
          await send(entry);
          throw Error("response lost");
        },
      }),
    ).rejects.toThrow("response lost");
    expect(await storage.listOutbox()).toHaveLength(2);
    expect(await pushReplica({ storage, pull, send })).toMatchObject({
      confirmed: 2,
      remaining: 0,
      conflicts: 0,
    });
    repo.invalidate();
    const saved = await store.snapshot(owner);
    expect(saved.cycles).toHaveLength(1);
    expect(saved.books[0]).toMatchObject({
      title: "읽으며 고친 제목",
      version: 3,
      bookshelves: ["내 인생 최고의 책들"],
    });
    expect(await repo.raw("library_books", book.id)).toMatchObject({
      version: 3,
      bookshelves: ["내 인생 최고의 책들"],
    });
  } finally {
    repo.close();
    storage.close();
  }
});

it("persists both optimistic effects together and restores the pending reading view after reopening", async () => {
  const owner = "start-offline";
  const book = await store.mutate(
    owner,
    command("addBook", {
      title: "오프라인",
      formats: ["paper"],
      bookshelves: shelves,
    }),
  );
  const before = await store.snapshot(owner);
  const storage = createMemoryReplica(owner);
  const transport = sqlSyncTransport(f.db, owner);
  await bootstrapReplica({ owner, storage, transport });
  const repo = createReplicaRepository(storage);
  const start = command("startReading", { bookId: book.id });
  const result = await queueReplicaCommand({
    storage,
    repository: repo,
    path: "/api/library",
    body: start,
  });
  expect((await repo.raw("library_books", book.id))?.bookshelves).toEqual([
    "내 인생 최고의 책들",
  ]);
  expect(
    await queueReplicaCommand({
      storage,
      repository: repo,
      path: "/api/library",
      body: start,
    }),
  ).toEqual(result);
  expect(await storage.listOutbox()).toHaveLength(1);
  const pending = (await storage.listOutbox())[0].command as QueuedChange;
  expect(pending.result.book).toMatchObject({
    id: book.id,
    version: 2,
    bookshelves: ["내 인생 최고의 책들"],
  });
  repo.close();
  const reopened = createLibraryRuntime(
    owner,
    storage,
    await storage.checkpoint(),
  );
  try {
    const visible = await reopened.withPendingReading(before);
    expect(visible.books[0].bookshelves).toEqual(["내 인생 최고의 책들"]);
    expect(visible.books[0].version).toBe(2);
    expect(visible.cycles).toMatchObject([
      { id: result.id, bookId: book.id, status: "reading" },
    ]);
  } finally {
    reopened.close();
  }
});

it("projects acknowledged queue removal and ignores replayed shelf patches older than the current book", async () => {
  const owner = "start-projection";
  const book = await store.mutate(
    owner,
    command("addBook", {
      title: "즉시 표시",
      formats: ["paper"],
      bookshelves: shelves,
    }),
  );
  const before = await store.snapshot(owner);
  const start = command("startReading", { bookId: book.id });
  const envelope = {
    requestId: start.requestId,
    family: "library",
    body: start,
  };
  const result = await executeSyncCommand(f.db, owner, envelope);
  const projected = projectLibrarySave(before, start, result);
  expect(projected.books[0]).toMatchObject({
    bookshelves: ["내 인생 최고의 책들"],
    version: 2,
  });
  expect(projected.cycles).toHaveLength(1);
  expect(projected.cycles[0]).not.toHaveProperty("book");
  expect(projectLibrarySave(projected, start, result)).toEqual(projected);
  const requeued = {
    ...projected,
    books: [{ ...projected.books[0], version: 3, bookshelves: shelves }],
  };
  expect(
    projectLibrarySave(
      requeued,
      start,
      await executeSyncCommand(f.db, owner, envelope),
    ).books,
  ).toEqual(requeued.books);
});
