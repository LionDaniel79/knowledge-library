import { afterEach, expect, it, vi } from "vitest";
import { emptyLibrary } from "../src/lib/domain";
import {
  readStartup,
  writeStartup,
  clearStartup,
} from "../src/client/replica/startup-cache";
import { createQueryWorker } from "../src/client/replica/query-worker";
import { resourceFixture } from "./helpers/replica-resources";
import {
  libraryRequest,
  registerLibraryRuntime,
} from "../src/client/replica/request";
function memory() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      values.set(k, v);
    },
    removeItem: (k: string) => {
      values.delete(k);
    },
  };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("keeps a bounded owner-isolated startup view without provider or authentication payloads", () => {
  const s = memory(),
    library = emptyLibrary();
  library.books.push({
    id: "book",
    title: "저장된 서재",
    author: "저자",
    publisher: "",
    isbn: "",
    formats: ["paper"],
    totalPages: 200,
    shelf: "",
    tags: [],
    version: 1,
    createdAt: "2026-10-17",
    enrichment: { api_key: "SECRET" },
    coverUrl: "https://provider.test/?key=SECRET",
    sourceData: {
      app: "Local PDF",
      libraryId: "lib",
      recordId: "pdf",
      raw: { secret: "SECRET" },
    },
  });
  writeStartup(s, "A", library);
  expect(readStartup(s, "A")?.books[0].title).toBe("저장된 서재");
  expect(readStartup(s, "B")).toBeNull();
  library.books[0].sourceData!.cover = null as any;
  library.books[0].sourceData!.libraryId = null as any;
  library.books[0].sourceData!.recordId = null as any;
  writeStartup(s, "A", library);
  expect(readStartup(s, "A")?.books[0].title).toBe("저장된 서재");
  expect([...s.values.values()].join("")).not.toContain("SECRET");
  clearStartup(s, "A");
  expect(readStartup(s, "A")).toBeNull();
  writeStartup(s, "A", {
    ...library,
    notes: [{ content: "x".repeat(2_000_000) }],
  } as any);
  expect(readStartup(s, "A")).toBeNull();
});
it("does not send cached-screen reads or saves to an unverified server account", async () => {
  const network = vi.fn(async () => Response.json({}));
  vi.stubGlobal("fetch", network);
  let reject!: (e: Error) => void;
  const waiting = new Promise<void>((_, no) => {
    reject = no;
  });
  const unregister = registerLibraryRuntime(null, () => waiting);
  const read = libraryRequest("/api/library");
  const save = libraryRequest("/api/library", {
    method: "POST",
    body: JSON.stringify({ type: "addNote" }),
  });
  await Promise.resolve();
  expect(network).not.toHaveBeenCalled();
  reject(Error("account changed"));
  await expect(read).rejects.toThrow("account changed");
  await expect(save).rejects.toThrow("account changed");
  expect(network).not.toHaveBeenCalled();
  unregister();
});
it("treats unavailable, damaged and mismatched startup storage as a cache miss", () => {
  const s = memory();
  writeStartup(s, "A", emptyLibrary());
  for (const [k, v] of s.values) {
    s.values.set(k, v.replace('"owner":"A"', '"owner":"B"'));
    expect(readStartup(s, "A")).toBeNull();
    s.values.set(k, "broken");
    expect(readStartup(s, "A")).toBeNull();
  }
  const blocked = {
    getItem() {
      throw Error("blocked");
    },
    setItem() {
      throw Error("full");
    },
    removeItem() {},
  };
  expect(() => writeStartup(blocked, "A", emptyLibrary())).not.toThrow();
  expect(readStartup(blocked, "A")).toBeNull();
});
it("opens the local overview without starting a search worker", async () => {
  const worker = vi.fn(function () {
    throw Error("worker unavailable");
  });
  vi.stubGlobal("Worker", worker);
  const f = await resourceFixture();
  expect((await f.repo.overview()).books.some((b) => b.id === f.book)).toBe(
    true,
  );
  expect(worker).not.toHaveBeenCalled();
  f.repo.close();
});
it("falls back to local queries when a search worker fails before initialization", async () => {
  let instance: any;
  vi.stubGlobal(
    "Worker",
    class {
      onerror: any;
      onmessage: any;
      postMessage = vi.fn();
      terminate = vi.fn();
      constructor() {
        instance = this;
      }
    },
  );
  const f = await resourceFixture(),
    data = await f.repo.index();
  const worker = createQueryWorker("owner");
  const initialized = worker.initialize(data);
  instance.onerror();
  await initialized;
  expect((await worker.query("books", {})).total).toBeGreaterThan(0);
  expect(instance.terminate).toHaveBeenCalled();
  worker.close();
  f.repo.close();
});
it("bounds an unresponsive worker and continues with the saved search index", async () => {
  vi.stubGlobal(
    "Worker",
    class {
      postMessage() {}
      terminate() {}
    },
  );
  const f = await resourceFixture(),
    data = await f.repo.index();
  vi.useFakeTimers();
  const worker = createQueryWorker("owner"),
    initialized = worker.initialize(data);
  await vi.advanceTimersByTimeAsync(3000);
  await initialized;
  expect((await worker.query("books", {})).total).toBeGreaterThan(0);
  worker.close();
  f.repo.close();
});
