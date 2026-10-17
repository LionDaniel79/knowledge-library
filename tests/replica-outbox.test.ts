import { expect, it, vi } from "vitest";
import { resourceFixture } from "./helpers/replica-resources";
import { queueReplicaCommand } from "../src/client/replica/outbox";
import { pushReplica } from "../src/client/replica/push";
import {
  createMemoryBackend,
  createMemoryReplica,
} from "../src/client/replica/memory-storage";
import { createLibraryRuntime } from "../src/client/replica/runtime";
it("keeps three offline edits and their original bases, dependencies and latest visible text", async () => {
  const f = await resourceFixture();
  for (const [i, content] of [
    "첫 수정",
    "둘째 수정",
    "마지막 수정",
  ].entries()) {
    const result = await queueReplicaCommand({
      storage: f.s,
      repository: f.repo,
      path: "/api/library",
      body: {
        requestId: crypto.randomUUID(),
        type: "editNote",
        payload: {
          id: f.note,
          expectedVersion: i + 1,
          title: "내 생각",
          content,
          kind: "thought",
          bookId: f.book,
        },
      },
    });
    expect(result.version).toBe(i + 2);
    expect((await f.repo.note(f.note)).content).toBe(content);
  }
  const entries = await f.s.listOutbox();
  expect(entries).toHaveLength(3);
  expect(entries[1].dependsOn).toContain(entries[0].requestId);
  expect((entries[0].command as any).base.content).toContain("정보와 신뢰");
  f.repo.close();
});
it("rechecks the signed-in owner before pushing remembered edits, including an already verified runtime", async () => {
  const f = await resourceFixture(),
    runtime = createLibraryRuntime("resources", f.s, await f.s.checkpoint());
  runtime.verifyOwner("resources");
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
        title: "내 생각",
        content: "내 계정의 글",
        kind: "thought",
        bookId: f.book,
      },
    },
  });
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (path: string) => {
    calls.push(path);
    if (path === "/api/sync/session")
      return Response.json({ ownerId: "different-owner" });
    throw Error("must not send");
  });
  try {
    await expect(runtime.sync({ reason: "manual" })).rejects.toMatchObject({
      status: 403,
    });
    expect(calls).toEqual(["/api/sync/session"]);
    expect(await f.s.listOutbox()).toHaveLength(1);
  } finally {
    vi.unstubAllGlobals();
    runtime.close();
    f.repo.close();
  }
});
it("atomically preserves the old display and cursor if storing an offline edit runs out of space", async () => {
  const backend = createMemoryBackend();
  let fail = false;
  const s = createMemoryReplica("resources", {
    ...backend,
    transaction: (fn) =>
      backend.transaction((io) =>
        fn({
          ...io,
          put: async (store, key, data) => {
            if (fail && store === "meta")
              throw new DOMException("full", "QuotaExceededError");
            await io.put(store, key, data);
          },
        }),
      ),
  });
  const f = await resourceFixture(s),
    before = await s.checkpoint();
  fail = true;
  await expect(
    queueReplicaCommand({
      storage: s,
      repository: f.repo,
      path: "/api/library",
      body: {
        requestId: crypto.randomUUID(),
        type: "editNote",
        payload: {
          id: f.note,
          expectedVersion: 1,
          title: "내 생각",
          content: "사라지면 안 되는 입력",
          kind: "thought",
          bookId: f.book,
        },
      },
    }),
  ).rejects.toThrow("full");
  fail = false;
  expect(await s.listOutbox()).toHaveLength(0);
  expect(await s.checkpoint()).toEqual(before);
  expect((await f.repo.note(f.note)).content).toContain("정보와 신뢰");
  f.repo.close();
});
it("retries a lost response with the same request id and preserves a later edit while acknowledging an older one", async () => {
  const f = await resourceFixture(),
    requestId = crypto.randomUUID();
  await queueReplicaCommand({
    storage: f.s,
    repository: f.repo,
    path: "/api/library",
    body: {
      requestId,
      type: "editNote",
      payload: {
        id: f.note,
        expectedVersion: 1,
        title: "내 생각",
        content: "서버에 보낼 글",
        kind: "thought",
        bookId: f.book,
      },
    },
  });
  const seen: string[] = [];
  await expect(
    pushReplica({
      storage: f.s,
      send: async (e) => {
        seen.push(e.requestId);
        throw Error("response lost");
      },
      pull: async () => {},
    }),
  ).rejects.toThrow("response lost");
  await pushReplica({
    storage: f.s,
    send: async (e) => {
      seen.push(e.requestId);
      await queueReplicaCommand({
        storage: f.s,
        repository: f.repo,
        path: "/api/library",
        body: {
          requestId: crypto.randomUUID(),
          type: "editNote",
          payload: {
            id: f.note,
            expectedVersion: 2,
            title: "내 생각",
            content: "나중에 쓴 글",
            kind: "thought",
            bookId: f.book,
          },
        },
      });
      return { id: f.note, version: 2 };
    },
    pull: async () => {},
  });
  expect(seen).toEqual([requestId, requestId]);
  expect((await f.repo.note(f.note)).content).toBe("나중에 쓴 글");
  expect(await f.s.listOutbox()).toHaveLength(1);
  f.repo.close();
});
it("does not lose a local edit committed between an acknowledgement checkpoint read and cleanup", async () => {
  const f = await resourceFixture();
  const queue = (content: string, expectedVersion: number) =>
    queueReplicaCommand({
      storage: f.s,
      repository: f.repo,
      path: "/api/library",
      body: {
        requestId: crypto.randomUUID(),
        type: "editNote",
        payload: {
          id: f.note,
          expectedVersion,
          title: "내 생각",
          content,
          kind: "thought",
          bookId: f.book,
        },
      },
    });
  await queue("먼저 쓴 글", 1);
  let interleave = false,
    sends = 0;
  const proxy = {
    ...f.s,
    transaction: async (fn: Parameters<typeof f.s.transaction>[0]) => {
      if (interleave) {
        interleave = false;
        await queue("전송 확인 중 쓴 글", 2);
      }
      return f.s.transaction(fn);
    },
  };
  const report = await pushReplica({
    storage: proxy,
    send: async () => {
      sends++;
      return { id: f.note, version: 2 };
    },
    pull: async () => {
      interleave = true;
    },
  });
  expect(report.remaining).toBe(1);
  expect(sends).toBe(1);
  expect((await f.repo.note(f.note)).content).toBe("전송 확인 중 쓴 글");
  f.repo.close();
});
