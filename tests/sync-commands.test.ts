import { expect, it } from "vitest";
import { testDatabase } from "./helpers/database";
import { executeSyncCommand } from "../src/server/sync/commands";
import { sqlSyncTransport } from "./helpers/sync-transport";
import { createMemoryReplica } from "../src/client/replica/memory-storage";
import { bootstrapReplica } from "../src/client/replica/bootstrap";
import { createReplicaRepository } from "../src/client/replica/repository";
import { queueReplicaCommand } from "../src/client/replica/outbox";
import { pushReplica } from "../src/client/replica/push";
import { pullReplica } from "../src/client/replica/pull";
import { createReplicaCoordinator } from "../src/client/replica/coordinator";
it("uses validated client ids and commits each requested change once even after a response is lost", async () => {
  const f = await testDatabase();
  const id = crypto.randomUUID(),
    requestId = crypto.randomUUID();
  const input = {
    requestId,
    family: "library",
    body: {
      requestId,
      entityId: id,
      type: "addBook",
      payload: { title: "기기에서 추가", formats: ["paper"] },
    },
  };
  try {
    const a = await executeSyncCommand(f.db, "command-owner", input);
    const b = await executeSyncCommand(f.db, "command-owner", input);
    expect(a).toEqual({ id, version: 1 });
    expect(b).toEqual(a);
    expect(
      (
        await f.db.query(
          "SELECT count(*)::int n FROM library_books WHERE owner_id='command-owner'",
        )
      ).rows[0].n,
    ).toBe(1);
    await expect(
      executeSyncCommand(f.db, "command-owner", {
        ...input,
        body: {
          ...input.body,
          payload: { title: "다른 내용", formats: ["paper"] },
        },
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      executeSyncCommand(f.db, "command-owner", {
        ...input,
        requestId: crypto.randomUUID(),
        family: "arbitrary-table",
      }),
    ).rejects.toThrow();
    await expect(executeSyncCommand(f.db, "", input)).rejects.toMatchObject({
      status: 401,
    });
  } finally {
    await f.pg.close();
  }
});
it("sends an offline new book, its note and successive edits to the real SQL store in dependency order, with response-loss replay", async () => {
  const f = await testDatabase(),
    owner = "roundtrip-owner",
    s = createMemoryReplica(owner),
    transport = sqlSyncTransport(f.db, owner),
    repo = createReplicaRepository(s);
  try {
    await bootstrapReplica({ owner, storage: s, transport });
    const queue = (type: string, payload: unknown) =>
      queueReplicaCommand({
        storage: s,
        repository: repo,
        path: "/api/library",
        body: { requestId: crypto.randomUUID(), type, payload },
      });
    const book = await queue("addBook", { title: "새 책", formats: ["paper"] });
    const note = await queue("addNote", {
      title: "생각",
      content: "첫 글",
      bookId: book.id,
      kind: "thought",
    });
    await queue("editNote", {
      id: note.id,
      expectedVersion: 1,
      title: "생각",
      content: "둘째 글",
      bookId: book.id,
      kind: "thought",
    });
    await queue("editNote", {
      id: note.id,
      expectedVersion: 2,
      title: "생각",
      content: "최종 글",
      bookId: book.id,
      kind: "thought",
    });
    const pending = await s.listOutbox();
    expect(pending[1].dependsOn).toContain(pending[0].requestId);
    await expect(
      pushReplica({
        storage: s,
        send: async (e) => {
          await transport.push!(e);
          throw Error("lost");
        },
        pull: async () => {
          await pullReplica({ owner, storage: s, transport });
        },
      }),
    ).rejects.toThrow("lost");
    const report = await createReplicaCoordinator({
      owner,
      storage: s,
      transport,
    }).syncReplica({ reason: "reconnect" });
    expect(report).toMatchObject({
      phase: "complete",
      pending: 0,
      conflicts: 0,
      failed: 0,
    });
    expect(await s.listOutbox()).toHaveLength(0);
    expect((await repo.note(note.id)).content).toBe("최종 글");
    expect(
      (
        await f.db.query(
          "SELECT id,content,version FROM library_notes WHERE owner_id=$1",
          [owner],
        )
      ).rows,
    ).toEqual([{ id: note.id, content: "최종 글", version: 3 }]);
  } finally {
    repo.close();
    await f.pg.close();
  }
});
it("synchronizes offline research, topics, assignments and successive introductions using stable device ids", async () => {
  const f = await testDatabase(),
    owner = "families-owner",
    s = createMemoryReplica(owner),
    transport = sqlSyncTransport(f.db, owner),
    repo = createReplicaRepository(s);
  try {
    await bootstrapReplica({ owner, storage: s, transport });
    const queue = (path: string, body: any) =>
      queueReplicaCommand({
        storage: s,
        repository: repo,
        path,
        body: { ...body, requestId: crypto.randomUUID() },
      });
    const book = await queue("/api/library", {
        type: "addBook",
        payload: { title: "주제의 책", formats: ["paper"] },
      }),
      note = await queue("/api/library", {
        type: "addNote",
        payload: {
          bookId: book.id,
          title: "생각",
          content: "신뢰에 대한 내 생각",
          kind: "thought",
        },
      });
    const research = await queue("/api/knowledge", {
      type: "createResearch",
      payload: {
        title: "신뢰 연구",
        kind: "thesis",
        question: "무엇을 믿는가",
      },
    });
    await queue("/api/knowledge", {
      type: "addResearchNote",
      payload: { researchId: research.id, noteId: note.id },
    });
    const topic = await queue("/api/thought-map", {
      type: "upsertTopic",
      payload: {
        name: "신뢰",
        parentId: null,
        aliases: [],
        description: "내 생각",
        kdcCodes: [],
      },
    });
    await queue("/api/thought-map", {
      type: "assignTopic",
      payload: {
        topicId: topic.id,
        sourceKind: "note",
        sourceId: note.id,
        sourceVersion: "1",
        status: "accepted",
        expectedVersion: 0,
      },
    });
    await queue("/api/book-introduction", {
      bookId: book.id,
      bookVersion: 1,
      expectedVersion: 0,
      text: "첫 소개",
      sources: [],
    });
    await queue("/api/book-introduction", {
      bookId: book.id,
      bookVersion: 1,
      expectedVersion: 1,
      text: "최종 소개",
      sources: [],
    });
    const status = await createReplicaCoordinator({
      owner,
      storage: s,
      transport,
    }).syncReplica({ reason: "online" });
    expect(status).toMatchObject({ pending: 0, failed: 0, conflicts: 0 });
    expect(
      ((await repo.read("/api/book-introduction?id=" + book.id)) as any)
        .introduction.text,
    ).toBe("최종 소개");
    expect(((await repo.read("/api/knowledge")) as any).research[0].id).toBe(
      research.id,
    );
    expect(((await repo.read("/api/thought-map")) as any).topics[0].id).toBe(
      topic.id,
    );
  } finally {
    repo.close();
    await f.pg.close();
  }
});
it("does not silently replace the note snapshot selected offline with a later edit from another device", async () => {
  const f = await testDatabase(),
    owner = "snapshot-conflict",
    s = createMemoryReplica(owner),
    transport = sqlSyncTransport(f.db, owner),
    repo = createReplicaRepository(s),
    coordinator = createReplicaCoordinator({ owner, storage: s, transport });
  try {
    await bootstrapReplica({ owner, storage: s, transport });
    const queue = (path: string, body: any) =>
      queueReplicaCommand({
        storage: s,
        repository: repo,
        path,
        body: { ...body, requestId: crypto.randomUUID() },
      });
    const n = await queue("/api/library", {
        type: "addNote",
        payload: {
          title: "원래 생각",
          content: "내가 선택한 글",
          kind: "thought",
        },
      }),
      r = await queue("/api/knowledge", {
        type: "createResearch",
        payload: { title: "연구", kind: "thesis", question: "질문" },
      });
    await coordinator.syncReplica({ reason: "initial" });
    await queue("/api/knowledge", {
      type: "addResearchNote",
      payload: { researchId: r.id, noteId: n.id },
    });
    const requestId = crypto.randomUUID();
    await executeSyncCommand(f.db, owner, {
      requestId,
      family: "library",
      body: {
        requestId,
        type: "editNote",
        payload: {
          id: n.id,
          expectedVersion: 1,
          title: "다른 기기",
          content: "나중에 달라진 글",
          kind: "thought",
        },
      },
    });
    const result = await coordinator.syncReplica({ reason: "reconnect" });
    expect(result.conflicts).toBe(1);
    expect(
      (
        await f.db.query(
          "SELECT count(*)::int n FROM library_research_items WHERE owner_id=$1",
          [owner],
        )
      ).rows[0].n,
    ).toBe(0);
  } finally {
    repo.close();
    await f.pg.close();
  }
});
