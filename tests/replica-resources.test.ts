import { afterEach, expect, it, vi } from "vitest";
import {
  libraryRequest,
  registerLibraryRuntime,
} from "../src/client/replica/request";
import { resourceFixture } from "./helpers/replica-resources";
import { syncKey } from "../src/lib/replica/entities";
import { sha256Bytes } from "../src/lib/replica/codec";
afterEach(() => vi.useRealTimers());
it("provides full note bodies to the map instead of relying on overview previews", async () => {
  const f = await resourceFixture();
  try {
    const state: any = await f.repo.read("/api/thought-map");
    expect(state.notes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: f.note,
          content: "정보와 신뢰를 함께 생각한다",
        }),
      ]),
    );
  } finally {
    f.repo.close();
  }
});
it("reuses the map snapshot without rescanning tables and invalidates it after a topic change", async () => {
  const f = await resourceFixture();
  try {
    await f.repo.read("/api/thought-map");
    const scans = vi.spyOn(f.s, "readPage");
    const before: any = await f.repo.read("/api/thought-map");
    expect(before.topics).toHaveLength(1);
    expect(scans).not.toHaveBeenCalled();
    const cp = (await f.s.checkpoint())!;
    const value = {
      id: f.topic,
      name: "신뢰",
      aliases: [],
      confirmed: true,
      version: 2,
      archived_at: "2026-10-21T00:00:00Z",
    };
    const inline = JSON.stringify(value),
      bytes = new TextEncoder().encode(inline);
    await f.s.stageRows(cp.generation, [
      {
        entity: "library_topics",
        key: syncKey("library_topics", value),
        revision: "2",
        deleted: false,
        inline,
        bytes: bytes.length,
        sha256: await sha256Bytes(bytes),
      },
    ]);
    await f.s.setCheckpoint(cp.generation, {
      entityRevisions: { ...cp.entityRevisions, library_topics: "2" },
    });
    const after: any = await f.repo.read("/api/thought-map");
    expect(after.topics).toHaveLength(0);
    expect(after.archivedTopics[0]).toMatchObject({ id: f.topic, version: 2 });
  } finally {
    f.repo.close();
  }
});
it("loads the thought map in table pages without reading thousands of excluded books individually", async () => {
  const f = await resourceFixture();
  const reads = vi.spyOn(f.s, "readRow");
  try {
    const state: any = await f.repo.read("/api/thought-map");
    expect(state.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ noteId: f.note, voice: "self" }),
      ]),
    );
    expect(reads).not.toHaveBeenCalled();
  } finally {
    f.repo.close();
  }
});
it("reads saved review originals, curation, sources, introductions, map, research and AI results without the network", async () => {
  // The fixture's usage belongs to October; the current real month is unrelated.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-21T00:00:00Z"));
  const f = await resourceFixture(),
    read = (path: string) => f.repo.read(path) as Promise<any>;
  expect((await read("/api/catalog-review?groupBy=book")).total).toBe(1);
  expect((await read("/api/catalog-review?id=" + f.review)).record.raw).toEqual(
    { original: "보존" },
  );
  expect(
    (await read("/api/curation?kind=book&id=" + f.book)).references[0].url,
  ).toContain("example.test");
  expect(
    (await read("/api/book-introduction?id=" + f.book)).introduction.text,
  ).toBe("내가 정리한 소개");
  expect((await read("/api/thought-map")).events[0]).toMatchObject({
    noteId: f.note,
    voice: "self",
    occurredOn: "2026-10-17",
  });
  expect((await read("/api/knowledge")).items[0].snapshot.content).toBe(
    "예전 원문",
  );
  const ai = await read("/api/assist");
  expect(ai.requests[0].result.valid).toBe(true);
  expect(ai.policy.runtimeMonthlyLimitUsd).toBe("5.000000");
  expect(ai.usage[0].spent).toBe("0.000001");
  expect(ai.execution).toBe("unavailable");
  const exported = await f.repo.exportData();
  expect(exported.tables.library_research_items![0].snapshot.content).toBe(
    "예전 원문",
  );
  expect(exported.tables.library_ai_usage).toHaveLength(1);
  f.repo.close();
});
it("never silently falls back to the network for unregistered saved-data routes", async () => {
  const f = await resourceFixture();
  const network = vi.fn(() => Promise.reject(Error("offline")));
  vi.stubGlobal("fetch", network);
  const unregister = registerLibraryRuntime({
    repository: f.repo,
    getSnapshot: () => ({ ready: true }),
  } as any);
  try {
    const response = await libraryRequest("/api/catalog-review?id=" + f.review);
    expect(response.headers.get("X-Library-Source")).toBe("device");
    expect((await response.json()).record.raw.original).toBe("보존");
    expect((await libraryRequest("/api/new-stored-data")).status).toBe(501);
    expect(network).not.toHaveBeenCalled();
    await expect(libraryRequest("/api/pdf")).rejects.toThrow("offline");
    expect(network).toHaveBeenCalledOnce();
  } finally {
    unregister();
    vi.unstubAllGlobals();
    f.repo.close();
  }
});
