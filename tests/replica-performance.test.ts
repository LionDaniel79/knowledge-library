import { afterEach, expect, it, vi } from "vitest";
import { queryBooks, queryNotes } from "../src/client/replica/queries";
import { createLibraryRuntime } from "../src/client/replica/runtime";
import { resourceFixture } from "./helpers/replica-resources";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("keeps search-only tables out of catalog reads and invalidation", async () => {
  const f = await resourceFixture();
  const read = vi.spyOn(f.s, "readPage");
  try {
    await f.repo.overview();
    const searchOnly = [
      "library_thought_events",
      "library_evolution_candidates",
      "library_analysis_feedback",
    ];
    expect(
      read.mock.calls.map((c) => c[0]).filter((e) => searchOnly.includes(e)),
    ).toEqual([]);
    read.mockClear();
    const cp = (await f.s.checkpoint())!;
    await f.s.setCheckpoint(cp.generation, {
      entityRevisions: {
        ...cp.entityRevisions,
        library_analysis_feedback: "2",
      },
    });
    await f.repo.overview();
    expect(read).not.toHaveBeenCalled();
    await f.repo.search({ text: "내가", layer: "all" });
    expect(read.mock.calls.map((c) => c[0])).toEqual(
      expect.arrayContaining(searchOnly),
    );
  } finally {
    f.repo.close();
  }
});

it("indexes topic membership once per book or note query and status once per book query", async () => {
  const f = await resourceFixture();
  try {
    const data = await f.repo.index();
    const original = data.books[0];
    data.books = Array.from({ length: 150 }, () => ({
      ...original,
      book: { ...original.book, id: crypto.randomUUID() },
    }));
    data.cycles = data.books.map((b) => ({
      id: crypto.randomUUID(),
      bookId: b.book.id,
      status: "completed",
      startedOn: null,
      completedOn: "2026-10-01",
      currentPage: 1,
      version: 1,
      createdAt: "2026-10-01",
    }));
    data.memberships = data.books.map((b) => ({
      source_kind: "book",
      source_id: b.book.id,
      topic_id: f.topic,
      status: "accepted",
    }));
    let membershipReads = 0,
      cycleReads = 0;
    data.memberships = data.memberships.map(
      (m) =>
        new Proxy(m, {
          get(t, p, r) {
            if (p === "source_kind") membershipReads++;
            return Reflect.get(t, p, r);
          },
        }),
    );
    data.cycles = data.cycles.map(
      (c) =>
        new Proxy(c, {
          get(t, p, r) {
            if (p === "bookId") cycleReads++;
            return Reflect.get(t, p, r);
          },
        }),
    );
    expect(
      (
        await queryBooks(data, f.s.owner, {
          topic: f.topic,
          filter: "completed",
        })
      ).total,
    ).toBe(150);
    expect(membershipReads).toBeLessThanOrEqual(450);
    expect(cycleReads).toBeLessThanOrEqual(450);
    data.notes = Array.from({ length: 150 }, (_, i) => ({
      ...data.notes[0],
      id: crypto.randomUUID(),
      bookId: data.books[i].book.id,
    }));
    membershipReads = 0;
    expect(queryNotes(data, { topic: f.topic }).total).toBe(150);
    expect(membershipReads).toBeLessThanOrEqual(450);
  } finally {
    f.repo.close();
  }
});

it("ignores unchanged cross-tab data broadcasts but observes changed and cleared device copies", async () => {
  let channel: { onmessage: (() => void) | null };
  vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal(
    "BroadcastChannel",
    class {
      onmessage = null;
      constructor() {
        channel = this;
      }
      postMessage() {}
      close() {}
    },
  );
  const f = await resourceFixture(),
    runtime = createLibraryRuntime(f.s.owner, f.s, await f.s.checkpoint());
  const invalidate = vi.spyOn(runtime.repository, "invalidate");
  const refreshed = () => new Promise((resolve) => setTimeout(resolve, 0));
  try {
    await refreshed();
    const revision = runtime.getSnapshot().revision;
    invalidate.mockClear();
    channel!.onmessage!();
    await refreshed();
    channel!.onmessage!();
    await refreshed();
    expect(runtime.getSnapshot().revision).toBe(revision);
    expect(invalidate).not.toHaveBeenCalled();
    const cp = (await f.s.checkpoint())!;
    await f.s.setCheckpoint(cp.generation, {
      localRevision: (cp.localRevision ?? 0) + 1,
    });
    channel!.onmessage!();
    await refreshed();
    expect(runtime.getSnapshot().revision).toBe(revision + 1);
    expect(invalidate).toHaveBeenCalledTimes(1);
    const latest = (await f.s.checkpoint())!;
    await f.s.setCheckpoint(latest.generation, {
      entityWrites: {
        ...latest.entityWrites,
        library_notes: (latest.entityWrites?.library_notes ?? 0) + 1,
      },
    });
    channel!.onmessage!();
    await refreshed();
    expect(runtime.getSnapshot().revision).toBe(revision + 2);
    expect(invalidate).toHaveBeenCalledTimes(2);
    await f.s.clearDownloaded();
    channel!.onmessage!();
    await refreshed();
    expect(runtime.getSnapshot().ready).toBe(false);
    expect(runtime.getSnapshot().revision).toBe(revision + 3);
  } finally {
    runtime.close();
    f.repo.close();
  }
});
