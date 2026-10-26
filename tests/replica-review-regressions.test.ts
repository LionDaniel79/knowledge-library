import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { bootstrapReplica } from "../src/client/replica/bootstrap";
import {
  applyReplicaResolution,
  loadReplicaConflict,
} from "../src/client/replica/conflicts";
import { createReplicaCoordinator } from "../src/client/replica/coordinator";
import { createMemoryReplica } from "../src/client/replica/memory-storage";
import { queueReplicaCommand } from "../src/client/replica/outbox";
import { pullReplica } from "../src/client/replica/pull";
import { pushReplica } from "../src/client/replica/push";
import { createReplicaRepository } from "../src/client/replica/repository";
import { createLibraryStore } from "../src/server/library-store";
import { executeSyncCommand } from "../src/server/sync/commands";
import { testDatabase } from "./helpers/database";
import { sqlSyncTransport } from "./helpers/sync-transport";
let f: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  f = await testDatabase();
});
afterAll(async () => {
  await f.pg.close();
});
async function fixture() {
  const owner = crypto.randomUUID(),
    storage = createMemoryReplica(owner),
    transport = sqlSyncTransport(f.db, owner),
    repository = createReplicaRepository(storage);
  await bootstrapReplica({ owner, storage, transport });
  const coordinator = createReplicaCoordinator({ owner, storage, transport });
  const queue = (path: string, body: any) =>
    queueReplicaCommand({
      storage,
      repository,
      path,
      body: { requestId: crypto.randomUUID(), ...body },
    });
  const remote = (family: string, type: string, payload: any) => {
    const requestId = crypto.randomUUID();
    return executeSyncCommand(f.db, owner, {
      requestId,
      family,
      body: { requestId, type, payload },
    });
  };
  const sync = () => coordinator.syncReplica({ reason: "manual" });
  return { owner, storage, transport, repository, queue, remote, sync };
}
it("preserves the editable preimage from opening a form even after a versionless collector update was pulled", async () => {
  const x = await fixture();
  const b: any = await x.remote("library", "addBook", {
    title: "Old title",
    publisher: "Old publisher",
    formats: ["paper"],
  });
  await x.sync();
  const opened = await x.repository.raw("library_books", b.id);
  await f.db.query(
    "UPDATE library_books SET publisher='New publisher' WHERE owner_id=$1 AND id=$2",
    [x.owner, b.id],
  );
  await x.sync();
  await expect(
    createLibraryStore(f.db).mutate(x.owner, {
      requestId: crypto.randomUUID(),
      type: "editBook",
      editBase: opened,
      payload: {
        id: b.id,
        expectedVersion: 1,
        title: "Online old form",
        publisher: "Old publisher",
        formats: ["paper"],
      },
    }),
  ).rejects.toMatchObject({ status: 409 });
  await x.queue("/api/library", {
    type: "editBook",
    editBase: opened,
    payload: {
      id: b.id,
      expectedVersion: 1,
      title: "My title",
      publisher: "Old publisher",
      formats: ["paper"],
    },
  });
  expect((await x.sync()).conflicts).toBe(1);
  expect(
    (
      await f.db.query("SELECT publisher FROM library_books WHERE id=$1", [
        b.id,
      ])
    ).rows[0].publisher,
  ).toBe("New publisher");
  x.repository.close();
});
for (const choice of ["mine", "server"] as const)
  it(`pins the selected research source after resolving the parent with ${choice}`, async () => {
    const x = await fixture();
    const n: any = await x.remote("library", "addNote", {
      title: "Thought",
      content: "Original",
      kind: "thought",
    });
    const r: any = await x.remote("knowledge", "createResearch", {
      title: "Research",
      kind: "thesis",
      question: "Q",
    });
    await x.sync();
    await x.queue("/api/library", {
      type: "editNote",
      payload: {
        id: n.id,
        expectedVersion: 1,
        title: "Thought",
        content: "My chosen source",
        kind: "thought",
      },
    });
    await x.queue("/api/knowledge", {
      type: "addResearchNote",
      payload: { researchId: r.id, noteId: n.id },
    });
    await x.remote("library", "editNote", {
      id: n.id,
      expectedVersion: 1,
      title: "Thought",
      content: "Other device text",
      kind: "thought",
    });
    expect((await x.sync()).conflicts).toBe(1);
    const first = (await x.storage.listOutbox()).find(
      (e) => e.state === "conflict",
    )!;
    await applyReplicaResolution(
      x.storage,
      await loadReplicaConflict(x.storage, first.requestId),
      { choice },
    );
    const result = await x.sync();
    const items = (
      await f.db.query(
        "SELECT snapshot FROM library_research_items WHERE owner_id=$1",
        [x.owner],
      )
    ).rows;
    if (choice === "mine") {
      expect(result.conflicts).toBe(0);
      expect(items[0]?.snapshot.note.content).toBe("My chosen source");
    } else {
      expect(result.conflicts).toBe(1);
      expect(items).toHaveLength(0);
    }
    x.repository.close();
  });
it("compares redacted cover preimages and keeps an unchanged private original without a download", async () => {
  const x = await fixture();
  const b: any = await x.remote("library", "addBook", {
    title: "Book",
    formats: ["paper"],
  });
  const privateCover =
    "https://example.invalid/cover?authKey=fake-private-value";
  await f.db.query("UPDATE library_books SET cover_url=$2 WHERE id=$1", [
    b.id,
    privateCover,
  ]);
  await x.sync();
  const base = await x.repository.raw("library_books", b.id);
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(Error("No network expected"));
  try {
    await x.queue("/api/library", {
      type: "editBook",
      payload: {
        id: b.id,
        expectedVersion: 1,
        title: "Changed",
        formats: ["paper"],
        coverUrl: base!.cover_url,
      },
    });
    expect(await x.sync()).toMatchObject({
      phase: "complete",
      pending: 0,
      failed: 0,
      conflicts: 0,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(
      (
        await f.db.query("SELECT cover_url FROM library_books WHERE id=$1", [
          b.id,
        ])
      ).rows[0].cover_url,
    ).toBe(privateCover);
    await x.queue("/api/library", {
      type: "editBook",
      payload: {
        id: b.id,
        expectedVersion: 2,
        title: "Changed again",
        formats: ["paper"],
        coverUrl: "",
      },
    });
    expect((await x.sync()).conflicts).toBe(0);
    expect(
      (
        await f.db.query("SELECT cover_url FROM library_books WHERE id=$1", [
          b.id,
        ])
      ).rows[0].cover_url,
    ).toBe("");
  } finally {
    fetch.mockRestore();
    x.repository.close();
  }
});
it("connects canonical research item ids to dependent placements after duplicate creation", async () => {
  const x = await fixture();
  const n: any = await x.remote("library", "addNote", {
    title: "N",
    content: "Source",
    kind: "thought",
  });
  const r: any = await x.remote("knowledge", "createResearch", {
    title: "R",
    kind: "thesis",
    question: "Q",
  });
  await x.sync();
  const item = await x.queue("/api/knowledge", {
    type: "addResearchNote",
    payload: { researchId: r.id, noteId: n.id },
  });
  await x.queue("/api/knowledge", {
    type: "placeResearchItem",
    payload: {
      itemId: item.id,
      expectedVersion: 0,
      role: "evidence",
      section: "A",
      position: 1,
      comment: "My comment",
      state: "active",
    },
  });
  const canonical: any = await x.remote("knowledge", "addResearchNote", {
    researchId: r.id,
    noteId: n.id,
  });
  expect(canonical.id).not.toBe(item.id);
  await expect(
    pushReplica({
      storage: x.storage,
      send: async (entry) => {
        await x.transport.push!(entry);
        throw Error("response lost");
      },
      pull: async () => {
        await pullReplica({
          owner: x.owner,
          storage: x.storage,
          transport: x.transport,
        });
      },
    }),
  ).rejects.toThrow("response lost");
  const result = await x.sync();
  expect(result).toMatchObject({ pending: 0, conflicts: 0, failed: 0 });
  expect(
    (
      await f.db.query(
        "SELECT id,comment FROM library_research_placements WHERE owner_id=$1",
        [x.owner],
      )
    ).rows,
  ).toEqual([{ id: canonical.id, comment: "My comment" }]);
  x.repository.close();
});
it("preserves queued edits as conflicts when another device excludes the book", async () => {
  const x = await fixture();
  const b: any = await x.remote("library", "addBook", {
    title: "Original",
    formats: ["paper"],
  });
  await x.sync();
  await x.queue("/api/library", {
    type: "editBook",
    payload: {
      id: b.id,
      expectedVersion: 1,
      title: "Offline change",
      formats: ["paper"],
    },
  });
  await f.db.query(
    "INSERT INTO library_book_exclusions(owner_id,id,kind,reason,batch_id) VALUES($1,$2,'paper','test',$3)",
    [x.owner, b.id, crypto.randomUUID()],
  );
  expect((await x.sync()).conflicts).toBe(1);
  expect(
    (await f.db.query("SELECT title FROM library_books WHERE id=$1", [b.id]))
      .rows[0].title,
  ).toBe("Original");
  x.repository.close();
});
it("grants the restricted runtime the pure safe projection helper", async () => {
  const sql = await readFile("db/operations/provision-web-runtime.sql", "utf8");
  const role = "review_runtime_" + crypto.randomUUID().replaceAll("-", "");
  await f.pg.exec(sql.replaceAll("library_web_runtime", role));
  expect(
    (
      await f.db.query(
        "SELECT has_function_privilege($1,'public.library_sync_redact(jsonb)','EXECUTE') AS redact, has_function_privilege($1,'public.library_sync_lock(text)','EXECUTE') AS lock",
        [role],
      )
    ).rows[0],
  ).toEqual({ redact: true, lock: true });
});
