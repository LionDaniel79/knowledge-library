import { expect, it, vi } from "vitest";
import {
  libraryRequest,
  registerLibraryRuntime,
} from "../src/client/replica/request";
import { resourceFixture } from "./helpers/replica-resources";
it("reads saved review originals, curation, sources, introductions, map, research and AI results without the network", async () => {
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
