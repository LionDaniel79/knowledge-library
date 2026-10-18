import { afterEach, expect, it, vi } from "vitest";
import { createReplicaReader } from "../src/client/replica/reader-client";
import { resourceFixture } from "./helpers/replica-resources";
import { createReplicaRepository } from "../src/client/replica/repository";
import { queueReplicaCommand } from "../src/client/replica/outbox";
it("rechecks the checkpoint when a saved catalog is read concurrently with a note edit", async () => {
  const f = await resourceFixture();
  await f.repo.notes({});
  const read = f.s.readIndex.bind(f.s);
  let changed = false;
  vi.spyOn(f.s, "readIndex").mockImplementation(async (key, generation) => {
    const cached = await read(key, generation);
    if (!changed && key === "catalog-index-v1") {
      changed = true;
      await queueReplicaCommand({
        storage: f.s,
        repository: f.repo,
        path: "/api/library",
        body: {
          requestId: crypto.randomUUID(),
          type: "editNote",
          payload: {
            id: f.note,
            expectedVersion: 1,
            title: "수정 도중에도 최신 글",
            content: "새 본문",
            kind: "thought",
          },
        },
      });
    }
    return cached;
  });
  const repo = createReplicaRepository(f.s);
  expect((await repo.notes({ q: "수정 도중에도 최신 글" })).items).toHaveLength(
    1,
  );
  repo.close();
});
it("opens one note without rebuilding the entire catalog or scanning unrelated tables", async () => {
  const f = await resourceFixture();
  vi.spyOn(f.s, "readPage").mockRejectedValue(
    Error("a note read must not scan all books/curations"),
  );
  expect((await f.repo.note(f.note)).content).toContain("정보와 신뢰");
  expect(f.s.readPage).not.toHaveBeenCalled();
});
afterEach(() => vi.useRealTimers());
function fixture() {
  const messages: any[] = [];
  const worker = {
    onmessage: null as any,
    onerror: null as any,
    onmessageerror: null as any,
    terminate: vi.fn(),
    postMessage: (m: any) => {
      messages.push(m);
      if (m.type === "open")
        queueMicrotask(() =>
          worker.onmessage({ data: { type: "ready", owner: "owner" } }),
        );
    },
  };
  const reader = createReplicaReader(
    "owner",
    "knowledge-library-replica",
    () => worker as any,
  );
  return { reader, worker, messages };
}
it("keeps large data in the worker and only sends owner/database/query arguments while the UI can continue", async () => {
  const f = fixture(),
    fallback = vi.fn();
  const pending = f.reader.read("books", [{ q: "신뢰" }], fallback);
  await vi.waitFor(() => expect(f.messages).toHaveLength(2));
  expect(f.messages[0]).toEqual({
    type: "open",
    owner: "owner",
    database: "knowledge-library-replica",
  });
  const call = f.messages[1];
  expect(call).toMatchObject({
    type: "read",
    method: "books",
    args: [{ q: "신뢰" }],
  });
  expect(call).not.toHaveProperty("data");
  await new Promise((resolve) => setTimeout(resolve, 0));
  f.worker.onmessage({
    data: { id: call.id, result: { items: [{ title: "신뢰" }] } },
  });
  expect(await pending).toEqual({ items: [{ title: "신뢰" }] });
  expect(fallback).not.toHaveBeenCalled();
  f.reader.close();
});
it("preserves real query errors and cancels pending reads on close without running them on the UI thread", async () => {
  const f = fixture(),
    fallback = vi.fn();
  const pending = f.reader.read("note", ["missing"], fallback);
  await vi.waitFor(() => expect(f.messages).toHaveLength(2));
  f.worker.onmessage({
    data: {
      id: f.messages[1].id,
      error: "기록을 찾을 수 없습니다.",
      status: 404,
    },
  });
  await expect(pending).rejects.toMatchObject({ status: 404 });
  const next = f.reader.read("overview", [], fallback);
  const check = expect(next).rejects.toMatchObject({ name: "AbortError" });
  f.reader.close();
  await check;
  expect(fallback).not.toHaveBeenCalled();
});
it("uses the existing local reader when workers cannot start and never discards the store", async () => {
  const fallback = vi.fn(async () => ({ total: 7 }));
  const reader = createReplicaReader("owner", "db", () => {
    throw Error("CSP blocked");
  });
  expect(await reader.read("books", [], fallback)).toEqual({ total: 7 });
  expect(fallback).toHaveBeenCalledTimes(1);
  reader.close();
});
it("does not deliver or start an old-owner fallback after the runtime closes during worker failure", async () => {
  const f = fixture(),
    fallback = vi.fn(async () => "old-owner-result");
  const read = f.reader.read("note", ["id"], fallback);
  const check = expect(read).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => expect(f.messages).toHaveLength(2));
  f.worker.onerror();
  f.reader.close();
  await check;
  expect(fallback).not.toHaveBeenCalled();
});
it("rejects a late disabled-worker fallback result after close", async () => {
  let finish!: (v: string) => void;
  const fallback = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  const reader = createReplicaReader("owner", "db", () => {
    throw Error("blocked");
  });
  const read = reader.read("note", ["id"], fallback);
  const check = expect(read).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => expect(fallback).toHaveBeenCalled());
  reader.close();
  const outcome = await Promise.race([
    read.then(
      () => "old",
      () => "aborted",
    ),
    new Promise((resolve) => setTimeout(() => resolve("still-waiting"), 40)),
  ]);
  finish("old-owner-result");
  expect(outcome).toBe("aborted");
  await check;
});
