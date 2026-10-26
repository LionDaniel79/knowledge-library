import { expect, it } from "vitest";
import { resourceFixture } from "./helpers/replica-resources";
import { queueReplicaCommand } from "../src/client/replica/outbox";
import { pushReplica } from "../src/client/replica/push";
import {
  loadReplicaConflict,
  applyReplicaResolution,
  migrateLegacyDrafts,
} from "../src/client/replica/conflicts";
import { sha256Bytes } from "../src/lib/replica/codec";
import { newDraft, writeDraft, readDrafts } from "../src/lib/offline-drafts";
async function changeServer(
  f: Awaited<ReturnType<typeof resourceFixture>>,
  patch: any,
) {
  const cp = (await f.s.checkpoint())!,
    value = { ...(await f.repo.raw("library_notes", f.note)), ...patch },
    inline = JSON.stringify(value),
    bytes = new TextEncoder().encode(inline);
  await f.s.stageRows(cp.generation, [
    {
      entity: "library_notes",
      key: JSON.stringify([f.note]),
      deleted: false,
      revision: "2",
      inline,
      bytes: bytes.length,
      sha256: await sha256Bytes(bytes),
    },
  ]);
  await f.s.setCheckpoint(cp.generation, {
    entityRevisions: { ...cp.entityRevisions, library_notes: "2" },
  });
  f.repo.invalidate();
}
it("compares the original, latest server text and newest dependent draft, then atomically keeps the chosen text under a fresh request", async () => {
  const f = await resourceFixture(),
    ids: string[] = [];
  for (const [i, content] of ["기기 첫 수정", "기기 최종 수정"].entries()) {
    const requestId = crypto.randomUUID();
    ids.push(requestId);
    await queueReplicaCommand({
      storage: f.s,
      repository: f.repo,
      path: "/api/library",
      body: {
        requestId,
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
  }
  await changeServer(f, { content: "다른 기기의 글", version: 2 });
  await pushReplica({
    storage: f.s,
    send: async () => {
      throw Object.assign(Error("conflict"), { status: 409 });
    },
    pull: async () => {},
  });
  const review = await loadReplicaConflict(f.s, ids[0]);
  expect(review.context.bookTitles[f.book]).toBe("넥서스");
  expect(review.base.content).toContain("정보와 신뢰");
  expect(review.latest.content).toBe("다른 기기의 글");
  expect(review.local.content).toBe("기기 최종 수정");
  await applyReplicaResolution(f.s, review, {
    choice: "merge",
    text: { title: "합친 생각", content: "두 기기의 생각을 합친 글" },
  });
  const remaining = await f.s.listOutbox();
  expect(remaining).toHaveLength(1);
  expect(remaining[0].requestId).not.toBe(ids[0]);
  expect((remaining[0].command as any).body.payload.expectedVersion).toBe(2);
  expect((await f.repo.note(f.note)).content).toBe("두 기기의 생각을 합친 글");
  expect(await f.s.listConflicts()).toHaveLength(0);
  expect((await f.s.listConflicts(true))[0].resolution.entries).toHaveLength(2);
  f.repo.close();
});
it("retains legacy originals on failure and verifies an existing queue before removing a duplicate draft", async () => {
  const f = await resourceFixture(),
    map = new Map<string, string>(),
    legacy = {
      get length() {
        return map.size;
      },
      key: (n: number) => [...map.keys()][n] ?? null,
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        map.set(k, v);
      },
      removeItem: (k: string) => {
        map.delete(k);
      },
    };
  const draft = newDraft("resources", {
    requestId: crypto.randomUUID(),
    type: "addNote",
    payload: {
      title: "이전 초안",
      content: "온전히 보존할 글",
      kind: "thought",
    },
  });
  writeDraft(legacy, draft);
  const failed = {
    ...f.s,
    transaction: async () => {
      throw Error("quota");
    },
  };
  const a = await migrateLegacyDrafts(failed, legacy, "resources");
  expect(a.failed).toBe(1);
  expect(readDrafts(legacy, "resources")).toHaveLength(1);
  await queueReplicaCommand({
    storage: f.s,
    repository: f.repo,
    path: "/api/library",
    body: draft.command,
  });
  const b = await migrateLegacyDrafts(f.s, legacy, "resources");
  expect(b.alreadyPresent).toBe(1);
  expect(readDrafts(legacy, "resources")).toHaveLength(0);
  expect(await f.s.listOutbox()).toHaveLength(1);
  expect((await f.s.listConflicts(true))[0].resolution.original).toContain(
    "온전히 보존할 글",
  );
  await pushReplica({
    storage: f.s,
    send: async () => {
      throw Object.assign(Error("changed"), { status: 409 });
    },
    pull: async () => {},
  });
  expect(
    (await f.s.listConflicts(true)).find(
      (c) => c.resolution?.kind === "legacy-migration",
    )?.resolution.original,
  ).toContain("온전히 보존할 글");
  f.repo.close();
});
it("rejects a stale review if another edit arrives, and offers a new copy after server deletion", async () => {
  const f = await resourceFixture(),
    requestId = crypto.randomUUID();
  const queue = (content: string, version: number) =>
    queueReplicaCommand({
      storage: f.s,
      repository: f.repo,
      path: "/api/library",
      body: {
        requestId: version === 1 ? requestId : crypto.randomUUID(),
        type: "editNote",
        payload: {
          id: f.note,
          expectedVersion: version,
          title: "내 글",
          content,
          kind: "thought",
          bookId: f.book,
        },
      },
    });
  await queue("내 원문", 1);
  await pushReplica({
    storage: f.s,
    send: async () => {
      throw Object.assign(Error("conflict"), { status: 409 });
    },
    pull: async () => {},
  });
  const review = await loadReplicaConflict(f.s, requestId);
  await queue("검토 중 더 쓴 글", 2);
  await expect(
    applyReplicaResolution(f.s, review, { choice: "server" }),
  ).rejects.toMatchObject({ status: 409 });
  expect(await f.s.listOutbox()).toHaveLength(2);
  const cp = (await f.s.checkpoint())!;
  await f.s.stageRows(cp.generation, [
    {
      entity: "library_notes",
      key: JSON.stringify([f.note]),
      revision: "3",
      deleted: true,
      sha256: null,
      bytes: 0,
    },
  ]);
  const deleted = await loadReplicaConflict(f.s, requestId);
  expect(deleted.unavailable).toContain("찾을 수 없습니다");
  await expect(
    applyReplicaResolution(f.s, deleted, { choice: "mine" }),
  ).rejects.toMatchObject({ status: 409 });
  await applyReplicaResolution(f.s, deleted, {
    choice: "copy",
    text: { title: "되살린 글", content: "검토 중 더 쓴 글" },
  });
  const pending = await f.s.listOutbox();
  expect(pending).toHaveLength(1);
  expect((pending[0].command as any).body.type).toBe("addNote");
  expect(pending[0].entityId).not.toBe(f.note);
  f.repo.close();
});
it("blocks overwriting an excluded book and aborts the final resolution transaction if a newer edit arrives after comparison", async () => {
  const f = await resourceFixture(),
    requestId = crypto.randomUUID();
  await queueReplicaCommand({
    storage: f.s,
    repository: f.repo,
    path: "/api/library",
    body: {
      requestId,
      type: "editBook",
      payload: {
        id: f.book,
        expectedVersion: 1,
        title: "고친 책 제목",
        formats: ["paper"],
      },
    },
  });
  await pushReplica({
    storage: f.s,
    send: async () => {
      throw Object.assign(Error("excluded"), { status: 409 });
    },
    pull: async () => {},
  });
  const cp = (await f.s.checkpoint())!,
    value = {
      id: f.book,
      state: "excluded",
      kind: "paper",
      reason: "제외",
      version: 1,
      created_at: "2026-10-17T01:00:00Z",
    },
    inline = JSON.stringify(value),
    bytes = new TextEncoder().encode(inline);
  await f.s.stageRows(cp.generation, [
    {
      entity: "library_book_exclusions",
      key: JSON.stringify([f.book]),
      deleted: false,
      revision: "3",
      inline,
      bytes: bytes.length,
      sha256: await sha256Bytes(bytes),
    },
  ]);
  const review = await loadReplicaConflict(f.s, requestId);
  expect(review.unavailable).toContain("제외");
  await expect(
    applyReplicaResolution(f.s, review, { choice: "mine" }),
  ).rejects.toMatchObject({ status: 409 });
  let interleaved = false;
  const proxy = {
    ...f.s,
    transaction: async (fn: Parameters<typeof f.s.transaction>[0]) => {
      if (!interleaved) {
        interleaved = true;
        const current = (await f.s.checkpoint())!;
        await f.s.setCheckpoint(current.generation, {
          localRevision: (current.localRevision ?? 0) + 1,
        });
      }
      return f.s.transaction(fn);
    },
  };
  await expect(
    applyReplicaResolution(proxy, review, { choice: "server" }),
  ).rejects.toMatchObject({ status: 409 });
  expect(await f.s.listOutbox()).toHaveLength(1);
  expect(await f.s.listConflicts()).toHaveLength(1);
  f.repo.close();
});
