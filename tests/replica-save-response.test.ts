import { afterEach, expect, it, vi } from "vitest";
import {
  libraryRequest,
  registerLibraryRuntime,
} from "../src/client/replica/request";
import type { LibraryRuntime } from "../src/client/replica/runtime";
import { projectLibrarySave } from "../src/client/replica/save-projection";
import { previewLibrary } from "../src/lib/preview-data";
import { resourceFixture } from "./helpers/replica-resources";
import { queueReplicaCommand } from "../src/client/replica/outbox";
import { createMemoryReplica } from "../src/client/replica/memory-storage";
import { createReplicaRepository } from "../src/client/replica/repository";
import type { QueuedChange } from "../src/client/replica/optimistic";
import { createLibraryRuntime } from "../src/client/replica/runtime";
it("coalesces a burst of acknowledged saves into one follow-up sync", async () => {
  const f = await resourceFixture(),
    runtime = createLibraryRuntime(f.s.owner, f.s, await f.s.checkpoint());
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ ownerId: f.s.owner })),
  );
  const sync = vi
    .spyOn(runtime.coordinator, "syncReplica")
    .mockImplementationOnce(async () => {
      await held;
      return runtime.coordinator.getStatus();
    })
    .mockImplementation(async () => runtime.coordinator.getStatus());
  try {
    const first = runtime.sync({ reason: "startup" });
    const saves = Array.from({ length: 5 }, () =>
      runtime.sync({ reason: "local-save" }),
    );
    release();
    await Promise.all([first, ...saves]);
    expect(sync).toHaveBeenCalledTimes(2);
  } finally {
    runtime.close();
  }
});
it("durably queues completion during the first download and retains its original version without a complete catalog", async () => {
  const storage = createMemoryReplica("partial-completion"),
    repository = createReplicaRepository(storage);
  const cycle = previewLibrary.cycles.find((c) => c.status === "reading")!,
    book = previewLibrary.books.find((b) => b.id === cycle.bookId)!;
  const body = {
    requestId: crypto.randomUUID(),
    type: "completeReading",
    payload: {
      id: cycle.id,
      expectedVersion: cycle.version,
      completedOn: "2026-10-18",
    },
  };
  const result = await queueReplicaCommand({
    storage,
    repository,
    path: "/api/library",
    body,
    readingSnapshot: { cycle, book },
  });
  const entry = (await storage.listOutbox())[0];
  expect(entry.baseVersion).toBe(cycle.version);
  expect(
    (entry.command as QueuedChange).effects.find(
      (e) => e.entity === "library_cycles",
    )?.after?.status,
  ).toBe("completed");
  expect(
    await queueReplicaCommand({
      storage,
      repository,
      path: "/api/library",
      body,
      readingSnapshot: { cycle, book },
    }),
  ).toEqual(result);
  expect(await storage.listOutbox()).toHaveLength(1);
});
it("creating a shelf never builds the full-text index", async () => {
  const f = await resourceFixture();
  const readPage = f.s.readPage.bind(f.s);
  vi.spyOn(f.s, "readPage").mockImplementation((entity, input) => {
    if (entity !== "library_shelves")
      throw Error("shelf save must not read unrelated book/note bodies");
    return readPage(entity, input);
  });
  vi.spyOn(f.repo, "index").mockRejectedValue(
    Error("must not build full text"),
  );
  const r = await queueReplicaCommand({
    storage: f.s,
    repository: f.repo,
    path: "/api/library",
    body: {
      requestId: crypto.randomUUID(),
      type: "createShelf",
      payload: { name: "기억할 책" },
    },
  });
  expect(r.queued).toBe(true);
  expect(f.repo.index).not.toHaveBeenCalled();
});
afterEach(() => vi.unstubAllGlobals());
it("never lets an older delete/restore acknowledgment remove a newer note or resurrect a newer deletion", () => {
  const data = structuredClone(previewLibrary),
    note = { ...data.notes[0], version: 3 };
  data.notes = [note];
  const command = (type: string) => ({
    requestId: crypto.randomUUID(),
    type,
    payload: { id: note.id, expectedVersion: 1 },
  });
  const deleted = projectLibrarySave(data, command("deleteNote"), {
    id: note.id,
    version: 2,
  });
  expect(deleted.notes).toEqual([note]);
  expect(deleted.deletedNotes ?? []).toHaveLength(0);
  data.notes = [];
  data.deletedNotes = [{ ...note, deletedAt: "2026-10-18" }];
  const restored = projectLibrarySave(data, command("restoreNote"), {
    id: note.id,
    version: 2,
  });
  expect(restored.notes).toHaveLength(0);
  expect(restored.deletedNotes).toEqual(data.deletedNotes);
  const purged = projectLibrarySave(
    data,
    {
      requestId: crypto.randomUUID(),
      type: "emptyNoteTrash",
      payload: { notes: [{ id: note.id, expectedVersion: 1 }] },
    },
    { id: "trash", version: 1 },
  );
  expect(purged.deletedNotes).toEqual(data.deletedNotes);
});
it("returns an acknowledged server save before sync and reads authoritative data while reconciliation is pending", async () => {
  let finish!: () => void;
  const sync = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const runtime = {
    getSnapshot: () => ({ ready: true }),
    sync: () => sync,
    repository: { read: vi.fn(() => Promise.resolve({ stale: true })) },
  } as unknown as LibraryRuntime;
  const remove = registerLibraryRuntime(runtime);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ fresh: true })),
  );
  try {
    const result = await Promise.race([
      libraryRequest("/api/book-covers", { method: "POST" }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
    ]);
    expect(
      result,
      "successful save must not wait for the whole library sync",
    ).not.toBeNull();
    expect(await (await libraryRequest("/api/assist")).json()).toEqual({
      fresh: true,
    });
    expect(runtime.repository.read).not.toHaveBeenCalled();
  } finally {
    finish();
    remove();
  }
});
it("projects completion and note edits immediately without replacing reading order or duplicating a retried save", () => {
  const data = structuredClone(previewLibrary),
    cycle = data.cycles.find((c) => c.status === "reading")!;
  data.readingSummary = {
    totalCompleted: 415,
    undatedCount: 2,
    completedIds: [],
    months: {},
  };
  const command = {
    requestId: crypto.randomUUID(),
    type: "completeReading",
    payload: {
      id: cycle.id,
      completedOn: "2026-10-18",
      expectedVersion: cycle.version,
    },
  };
  const saved = projectLibrarySave(data, command, {
    id: cycle.id,
    version: cycle.version + 1,
  });
  expect(saved.cycles.find((c) => c.id === cycle.id)?.status).toBe("completed");
  expect(
    saved.cycles.filter((c) => c.id !== cycle.id).map((c) => c.id),
  ).toEqual(data.cycles.filter((c) => c.id !== cycle.id).map((c) => c.id));
  expect(saved.readingSummary?.totalCompleted).toBe(416);
  expect(saved.readingSummary?.months["2026-10"].monthCount).toBe(1);
  expect(
    projectLibrarySave(saved, command, {
      id: cycle.id,
      version: cycle.version + 1,
    }),
  ).toEqual(saved);
  const note = saved.notes[0];
  const edited = projectLibrarySave(
    saved,
    {
      requestId: crypto.randomUUID(),
      type: "editNote",
      payload: {
        ...note,
        title: "새 기록",
        content: "바로 보이는 생각",
        expectedVersion: note.version,
      },
    },
    { id: note.id, version: note.version + 1 },
  );
  expect(edited.notes.find((n) => n.id === note.id)?.content).toBe(
    "바로 보이는 생각",
  );
  expect(saved.notes.find((n) => n.id === note.id)?.content).toBe(note.content);
});
