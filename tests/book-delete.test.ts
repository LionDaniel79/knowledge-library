import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { resourceFixture } from "./helpers/replica-resources";
import { createLibraryStore } from "../src/server/library-store";
import { createBookExclusionStore } from "../src/server/book-exclusions";
import { readBookPage } from "../src/server/book-catalog";
import { importPdfCatalog } from "../src/server/pdf-catalog-import";
import { executeSyncCommand } from "../src/server/sync/commands";
import { queueReplicaCommand } from "../src/client/replica/outbox";
import { syncCommandEnvelope } from "../src/lib/replica/command-envelope";
import { pushReplica } from "../src/client/replica/push";
import {
  loadReplicaConflict,
  applyReplicaResolution,
} from "../src/client/replica/conflicts";
import { createLocalReplicaRepository } from "../src/client/replica/repository-local";
import {
  prepareOptimistic,
  type QueuedChange,
} from "../src/client/replica/optimistic";
import { sha256Bytes } from "../src/lib/replica/codec";
import type { SyncEntity } from "../src/lib/replica/entities";

let f: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  f = await testDatabase();
});
afterAll(async () => {
  await f?.pg.close();
});
const deletion = (id: string, expectedVersion = 1) => ({
  action: "delete",
  id,
  expectedVersion,
  requestId: randomUUID(),
});
async function book(owner: string) {
  return (
    await createLibraryStore(f.db).mutate(owner, {
      requestId: randomUUID(),
      type: "addBook",
      payload: { title: "삭제해도 보관할 책", formats: ["paper"] },
    })
  ).id;
}

it("removes a selected owned book while retaining its PDF, notes and reading history across importer replay", async () => {
  const owner = "delete-retained",
    docId = randomUUID();
  const doc = {
    id: docId,
    root: "E:/synthetic",
    path: `E:/synthetic/${docId}.pdf`,
    relative_path: `${docId}.pdf`,
    title: "삭제 검증 PDF",
    author: "검증",
    page_count: 12,
    bytes: 1024,
    mtime_ns: "123456789",
    processing_scope: "full",
    material_kind: "book",
    scope_reason: "검증",
    scope_version: "test",
  };
  await importPdfCatalog(f.db, owner, [doc]);
  const row = (
    await f.db.query(
      "SELECT book_id FROM library_documents WHERE owner_id=$1 AND id=$2",
      [owner, docId],
    )
  ).rows[0];
  const library = createLibraryStore(f.db);
  await library.mutate(owner, {
    requestId: randomUUID(),
    type: "addNote",
    payload: {
      bookId: row.book_id,
      title: "원문 메모",
      content: "유지해야 할 내용",
    },
  });
  await library.mutate(owner, {
    requestId: randomUUID(),
    type: "startReading",
    payload: { bookId: row.book_id, startedOn: "2026-10-30" },
  });
  const before = (
    await f.db.query(
      "SELECT version FROM library_books WHERE owner_id=$1 AND id=$2",
      [owner, row.book_id],
    )
  ).rows[0];
  const command = deletion(row.book_id, before.version),
    store = createBookExclusionStore(f.db);
  const result = await store.remove(owner, command);
  expect(result).toMatchObject({
    id: row.book_id,
    deleted: true,
    version: before.version + 1,
  });
  expect(await store.remove(owner, command)).toEqual(result);
  expect((await readBookPage(f.db, owner, {})).total).toBe(0);
  expect((await store.list(owner, {})).items[0]).toMatchObject({
    id: row.book_id,
    kind: "book",
  });
  await importPdfCatalog(f.db, owner, [doc]);
  expect((await readBookPage(f.db, owner, {})).total).toBe(0);
  for (const table of [
    "library_books",
    "library_documents",
    "library_notes",
    "library_cycles",
  ]) {
    expect(
      (await f.db.query(`SELECT id FROM ${table} WHERE owner_id=$1`, [owner]))
        .rows,
    ).toHaveLength(1);
  }
  expect(
    (
      await f.db.query("SELECT content FROM library_notes WHERE owner_id=$1", [
        owner,
      ])
    ).rows[0].content,
  ).toBe("유지해야 할 내용");
});

it("checks ownership and stale book versions, and restoring invalidates a previous delete confirmation", async () => {
  const owner = "delete-cas",
    id = await book(owner),
    store = createBookExclusionStore(f.db);
  const command = deletion(id);
  await expect(store.remove("other-owner", command)).rejects.toMatchObject({
    status: 404,
  });
  await expect(
    store.remove(owner, { ...command, expectedVersion: 99 }),
  ).rejects.toMatchObject({ status: 409 });
  await store.remove(owner, command);
  await expect(
    store.remove(owner, { ...command, requestId: randomUUID() }),
  ).rejects.toMatchObject({ status: 409 });
  const entry = (await store.list(owner, {})).items[0];
  await store.restore(owner, {
    id,
    expectedVersion: entry.version,
    requestId: randomUUID(),
  });
  expect((await readBookPage(f.db, owner, {})).items[0]).toMatchObject({
    id,
    version: 3,
  });
  await expect(
    store.remove(owner, { ...command, requestId: randomUUID() }),
  ).rejects.toMatchObject({ status: 409 });
  expect((await readBookPage(f.db, owner, {})).total).toBe(1);
  await expect(
    store.remove(owner, { ...command, expectedVersion: 2 }),
  ).rejects.toMatchObject({ status: 409 });
});

it("executes the same owned delete command through sync exactly once", async () => {
  const owner = "delete-sync",
    id = await book(owner),
    body = deletion(id);
  const command = {
    ownerId: owner,
    family: "exclusions",
    path: "/api/book-exclusions",
    requestId: body.requestId,
    body,
  };
  const result = await executeSyncCommand(f.db, owner, command);
  expect(result).toMatchObject({ id, deleted: true, version: 2 });
  expect(await executeSyncCommand(f.db, owner, command)).toEqual(result);
  await expect(
    executeSyncCommand(f.db, "other", command),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    executeSyncCommand(f.db, owner, {
      ...command,
      body: { ...body, expectedVersion: 2 },
    }),
  ).rejects.toMatchObject({ status: 409 });
  expect(
    (
      await f.db.query(
        "SELECT version FROM library_books WHERE owner_id=$1 AND id=$2",
        [owner, id],
      )
    ).rows[0].version,
  ).toBe(2);
});

it("durably removes and restores an offline book without discarding its records, and preserves command order", async () => {
  const local = await resourceFixture();
  try {
    const body = deletion(local.book),
      beforeNote = await local.repo.note(local.note);
    const result = await queueReplicaCommand({
      storage: local.s,
      repository: local.repo,
      path: "/api/book-exclusions",
      body,
    });
    expect(result).toMatchObject({ deleted: true, version: 2, queued: true });
    expect(
      await queueReplicaCommand({
        storage: local.s,
        repository: local.repo,
        path: "/api/book-exclusions",
        body,
      }),
    ).toEqual(result);
    expect(((await local.repo.read("/api/books")) as any).total).toBe(0);
    expect(await local.repo.note(local.note)).toEqual(beforeNote);
    expect(await local.repo.raw("library_books", local.book)).toMatchObject({
      title: "넥서스",
      version: 2,
    });
    const trash = (await local.repo.read("/api/book-exclusions")) as any;
    expect(trash.items[0]).toMatchObject({
      id: local.book,
      kind: "book",
      version: 1,
    });
    const restore = {
      id: local.book,
      expectedVersion: 1,
      requestId: randomUUID(),
    };
    await queueReplicaCommand({
      storage: local.s,
      repository: local.repo,
      path: "/api/book-exclusions",
      body: restore,
    });
    expect(
      ((await local.repo.read("/api/books")) as any).items[0],
    ).toMatchObject({ id: local.book, version: 3 });
    expect(((await local.repo.read("/api/book-exclusions")) as any).total).toBe(
      0,
    );
    const entries = await local.s.listOutbox();
    expect(entries).toHaveLength(2);
    expect(entries[1].dependsOn).toContain(entries[0].requestId);
    expect(syncCommandEnvelope(entries[0])).toMatchObject({
      ownerId: local.s.owner,
      family: "exclusions",
      body,
    });
    await expect(
      queueReplicaCommand({
        storage: local.s,
        repository: local.repo,
        path: "/api/book-exclusions",
        body: deletion(local.book),
      }),
    ).rejects.toMatchObject({ status: 409 });
  } finally {
    local.repo.close();
  }
});

it("reviews an offline deletion against a concurrent book edit and replays its original intent with the reviewed version", async () => {
  const local = await resourceFixture();
  async function stage(entity: SyncEntity, row: any) {
    const cp = (await local.s.checkpoint())!,
      inline = JSON.stringify(row),
      bytes = new TextEncoder().encode(inline);
    await local.s.stageRows(cp.generation, [
      {
        entity,
        key: JSON.stringify([row.id]),
        revision: String(row.version),
        deleted: false,
        inline,
        bytes: bytes.length,
        sha256: await sha256Bytes(bytes),
      },
    ]);
    local.repo.invalidate();
  }
  try {
    await queueReplicaCommand({
      storage: local.s,
      repository: local.repo,
      path: "/api/book-exclusions",
      body: deletion(local.book),
    });
    await stage("library_books", {
      ...(await local.repo.raw("library_books", local.book)),
      title: "다른 기기에서 바꾼 제목",
      version: 2,
    });
    await pushReplica({
      storage: local.s,
      send: async () => {
        throw Object.assign(Error("concurrent edit"), { status: 409 });
      },
      pull: async () => {},
    });
    const review = await loadReplicaConflict(
      local.s,
      (await local.s.listOutbox())[0].requestId,
    );
    expect(review.latest).toMatchObject({
      title: "다른 기기에서 바꾼 제목",
      version: 2,
    });
    expect(review.base).toMatchObject({ title: "넥서스", version: 1 });
    await applyReplicaResolution(local.s, review, { choice: "mine" });
    const entry = (await local.s.listOutbox())[0],
      command = entry.command as QueuedChange;
    expect(command.body).toMatchObject({
      action: "delete",
      id: local.book,
      expectedVersion: 2,
    });
    expect(command.body).not.toHaveProperty("entityId");
    const server = createLocalReplicaRepository({
      ...local.s,
      listOutbox: async () => [],
    });
    try {
      const prepared = await prepareOptimistic(
        server,
        command.path,
        command.body,
        command.at,
      );
      expect(prepared.result).toMatchObject({ deleted: true, version: 3 });
      expect(
        prepared.effects.find((effect) => effect.entity === "library_books")
          ?.after,
      ).toMatchObject({ title: "다른 기기에서 바꾼 제목", version: 3 });
    } finally {
      server.close();
    }
  } finally {
    local.repo.close();
  }
});
