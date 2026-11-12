import { afterAll, beforeAll, expect, it } from "vitest";
import { testDatabase } from "./helpers/database";
import { createLibraryStore } from "../src/server/library-store";
import { defaultShelves } from "../src/lib/catalog";
import { bootstrapReplica } from "../src/client/replica/bootstrap";
import { createMemoryReplica } from "../src/client/replica/memory-storage";
import { createReplicaRepository } from "../src/client/replica/repository";
import { queueReplicaCommand } from "../src/client/replica/outbox";
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
beforeAll(async () => {
  f = await testDatabase();
  store = createLibraryStore(f.db);
});
afterAll(async () => f?.pg.close());
it("does not create a real shelf for the virtual unclassified state", async () => {
  await expect(
    store.mutate("virtual", command("createShelf", { name: "미분류" })),
  ).rejects.toMatchObject({ status: 400 });
});

async function setup(owner: string) {
  const shelf = await store.mutate(
    owner,
    command("createShelf", { name: "지울 책장" }),
  );
  await store.mutate(owner, command("createShelf", { name: "남길 책장" }));
  const books = [];
  for (const bookshelves of [
    ["지울 책장", "남길 책장"],
    ["지울 책장"],
    ["남길 책장"],
  ]) {
    books.push(
      await store.mutate(
        owner,
        command("addBook", {
          title: "보존할 책",
          formats: ["paper"],
          bookshelves,
        }),
      ),
    );
  }
  await store.mutate(owner, command("startReading", { bookId: books[0].id }));
  await store.mutate(
    owner,
    command("addNote", {
      bookId: books[0].id,
      title: "보존할 메모",
      content: "원문 보존",
      kind: "thought",
    }),
  );
  return { shelf, books };
}

it("deletes only the owner's shelf membership, preserves books and records, and replays without touching a recreated shelf", async () => {
  const owner = "shelf-delete-owner",
    other = "shelf-delete-other";
  const { shelf } = await setup(owner);
  await setup(other);
  const before = await store.snapshot(owner),
    foreign = await store.snapshot(other);
  const remove = command("deleteShelf", { name: " 지울 책장 " });
  const result = await store.mutate(owner, remove);
  const saved = await store.snapshot(owner);
  expect(result.id).toBe(shelf.id);
  expect(saved).toEqual({
    ...before,
    shelves: before.shelves!.filter((s) => s !== "지울 책장"),
    books: before.books.map((b) =>
      b.bookshelves?.includes("지울 책장")
        ? {
            ...b,
            version: b.version + 1,
            bookshelves: b.bookshelves.filter((s) => s !== "지울 책장"),
          }
        : b,
    ),
  });
  expect(await store.snapshot(other)).toEqual(foreign);
  expect(result.changedBooks).toHaveLength(2);
  for (const book of before.books.slice(0, 2)) {
    expect((await store.revisions(owner, book.id)).at(-1)).toMatchObject({
      action: "deleteShelf",
      before: book,
      after: saved.books.find((b) => b.id === book.id),
    });
  }
  const history = await store.revisions(owner, shelf.id);
  expect(history.at(-1)).toMatchObject({
    action: "deleteShelf",
    before: { id: shelf.id, name: "지울 책장" },
    after: null,
  });
  expect(await store.mutate(owner, remove)).toEqual(result);
  expect(await store.snapshot(owner)).toEqual(saved);
  expect(await store.revisions(owner, shelf.id)).toEqual(history);
  await store.mutate(owner, command("createShelf", { name: "지울 책장" }));
  const recreated = await store.snapshot(owner);
  expect(await store.mutate(owner, remove)).toEqual(result);
  expect(await store.snapshot(owner)).toEqual(recreated);
  await expect(
    store.mutate(owner, { ...remove, payload: { name: "남길 책장" } }),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    store.mutate(
      "shelf-outsider",
      command("deleteShelf", { name: "지울 책장" }),
    ),
  ).rejects.toMatchObject({ status: 404 });
});

it("protects built-in and virtual shelves consistently online and offline", async () => {
  const owner = "shelf-protected";
  await setup(owner);
  const before = await store.snapshot(owner),
    storage = createMemoryReplica(owner);
  await bootstrapReplica({
    owner,
    storage,
    transport: sqlSyncTransport(f.db, owner),
  });
  const repository = createReplicaRepository(storage);
  try {
    for (const name of [...defaultShelves, "미분류"]) {
      const body = command("deleteShelf", { name });
      await expect(store.mutate(owner, body)).rejects.toMatchObject({
        status: 400,
      });
      await expect(
        queueReplicaCommand({
          storage,
          repository,
          path: "/api/library",
          body,
        }),
      ).rejects.toMatchObject({ status: 400 });
    }
    expect(await store.snapshot(owner)).toEqual(before);
    expect(await storage.listOutbox()).toHaveLength(0);
  } finally {
    repository.close();
    storage.close();
  }
});

it("carries existing curation to each changed book version without removing original evidence", async () => {
  const owner = "shelf-curation";
  const { books } = await setup(owner);
  const reference = crypto.randomUUID(),
    item = crypto.randomUUID(),
    run = crypto.randomUUID();
  await f.db.query(
    "INSERT INTO library_curation_runs(id,owner_id,scope_hash,executor) VALUES($1,$2,'shelf-test','library')",
    [run, owner],
  );
  await f.db.query(
    "INSERT INTO library_reference_sources(id,owner_id,source_kind,source_id,source_version,url,provider,title,content_hash,excerpt,edition_match) VALUES($1,$2,'book',$3,'1','https://example.test/book','library','원문','hash','본문','isbn')",
    [reference, owner, books[0].id],
  );
  await f.db.query(
    "INSERT INTO library_curation_items(id,owner_id,run_id,source_kind,source_id,source_version,kind,value,evidence,coverage,origin,generator,fingerprint,state) VALUES($1,$2,$5,'book',$3,'1','description','\"책 소개\"'::jsonb,$4,'metadata','provider','library',$6,'active')",
    [
      item,
      owner,
      books[0].id,
      JSON.stringify({ referenceId: reference }),
      run,
      item,
    ],
  );
  await store.mutate(owner, command("deleteShelf", { name: "지울 책장" }));
  const items = (
    await f.db.query(
      "SELECT source_version,value,evidence FROM library_curation_items WHERE owner_id=$1 AND source_id=$2 ORDER BY source_version",
      [owner, books[0].id],
    )
  ).rows;
  expect(items.map((i) => i.source_version)).toEqual(["1", "2"]);
  expect(items.map((i) => i.value)).toEqual(["책 소개", "책 소개"]);
  expect(items[0].evidence.referenceId).toBe(reference);
  expect(items[1].evidence.referenceId).not.toBe(reference);
  expect(
    (
      await f.db.query(
        "SELECT id FROM library_reference_sources WHERE owner_id=$1 AND source_id=$2",
        [owner, books[0].id],
      )
    ).rows,
  ).toHaveLength(2);
});

it("rolls back memberships, shelf deletion, versions and revisions when saving the receipt fails", async () => {
  const owner = "shelf-rollback";
  const { shelf } = await setup(owner);
  const before = await store.snapshot(owner),
    history = await store.revisions(owner, shelf.id);
  const failing = createLibraryStore({
    query: f.db.query,
    transaction: (fn) =>
      f.db.transaction((tx) =>
        fn({
          query: (sql, params) => {
            if (sql.startsWith("UPDATE library_operations SET result"))
              throw Error("response interrupted");
            return tx.query(sql, params);
          },
        }),
      ),
  });
  await expect(
    failing.mutate(owner, command("deleteShelf", { name: "지울 책장" })),
  ).rejects.toThrow("response interrupted");
  expect(await store.snapshot(owner)).toEqual(before);
  expect(await store.revisions(owner, shelf.id)).toEqual(history);
});

it("persists offline deletion, retries a lost sync response and preserves dependent book edits", async () => {
  const owner = "shelf-offline";
  const { shelf, books } = await setup(owner);
  const before = await store.snapshot(owner),
    storage = createMemoryReplica(owner),
    transport = sqlSyncTransport(f.db, owner);
  await bootstrapReplica({ owner, storage, transport });
  let repository = createReplicaRepository(storage);
  try {
    const body = command("deleteShelf", { name: "지울 책장" });
    const result = await queueReplicaCommand({
      storage,
      repository,
      path: "/api/library",
      body,
    });
    expect(await repository.raw("library_shelves", shelf.id)).toBeUndefined();
    expect(await repository.raw("library_books", books[0].id)).toMatchObject({
      version: 2,
      bookshelves: ["남길 책장"],
    });
    expect(
      await queueReplicaCommand({
        storage,
        repository,
        path: "/api/library",
        body,
      }),
    ).toEqual(result);
    expect(await storage.listOutbox()).toHaveLength(1);
    const queued = (await storage.listOutbox())[0].command as QueuedChange;
    expect(
      queued.effects.filter((e) => e.entity === "library_books"),
    ).toHaveLength(2);
    const projected = projectLibrarySave(before, body, result);
    expect(projected.books[0]).toMatchObject({
      version: 2,
      bookshelves: ["남길 책장"],
    });
    expect(projectLibrarySave(projected, body, result)).toEqual(projected);
    const newer = {
      ...projected,
      books: [
        {
          ...projected.books[0],
          version: 3,
          bookshelves: ["남길 책장", "책 대기열"],
        },
      ],
    };
    expect(projectLibrarySave(newer, body, result).books).toEqual(newer.books);
    repository.close();
    repository = createReplicaRepository(storage);
    expect(await repository.shelves()).not.toContain("지울 책장");
    await queueReplicaCommand({
      storage,
      repository,
      path: "/api/library",
      body: command("editBook", {
        ...before.books[0],
        expectedVersion: 2,
        title: "보존한 수정",
        bookshelves: ["남길 책장"],
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
    expect(await pushReplica({ storage, pull, send })).toMatchObject({
      confirmed: 2,
      remaining: 0,
      conflicts: 0,
    });
    repository.invalidate();
    const saved = await store.snapshot(owner);
    expect(saved.shelves).not.toContain("지울 책장");
    expect(saved.books[0]).toMatchObject({
      title: "보존한 수정",
      version: 3,
      bookshelves: ["남길 책장"],
    });
    expect(saved.notes).toEqual(before.notes);
    expect(saved.cycles).toEqual(before.cycles);
    expect(await repository.raw("library_shelves", shelf.id)).toBeUndefined();
    expect(await repository.raw("library_books", books[0].id)).toMatchObject({
      title: "보존한 수정",
      version: 3,
      bookshelves: ["남길 책장"],
    });
  } finally {
    repository.close();
    storage.close();
  }
});
