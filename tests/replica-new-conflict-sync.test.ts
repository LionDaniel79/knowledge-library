import { expect, it } from "vitest";
import { testDatabase } from "./helpers/database";
import { sqlSyncTransport } from "./helpers/sync-transport";
import { createMemoryReplica } from "../src/client/replica/memory-storage";
import { createReplicaRepository } from "../src/client/replica/repository";
import { bootstrapReplica } from "../src/client/replica/bootstrap";
import { pullReplica } from "../src/client/replica/pull";
import { queueReplicaCommand } from "../src/client/replica/outbox";
import { pushReplica } from "../src/client/replica/push";
import {
  loadReplicaConflict,
  applyReplicaResolution,
} from "../src/client/replica/conflicts";
import { executeSyncCommand } from "../src/server/sync/commands";

for (const existing of [false, true])
  it(`explicitly restores an archived topic before applying its ${existing ? "existing" : "new"} reviewed classification, then pushes without another conflict`, async () => {
    const f = await testDatabase(),
      owner = "archived-topic-owner",
      s = createMemoryReplica(owner),
      transport = sqlSyncTransport(f.db, owner),
      repo = createReplicaRepository(s);
    const command = (
      type: string,
      payload: any,
      family = "thought-map",
      path = "/api/thought-map",
    ) => {
      const requestId = crypto.randomUUID();
      return executeSyncCommand(f.db, owner, {
        requestId,
        family,
        path,
        body: { requestId, type, payload },
      } as any) as Promise<any>;
    };
    try {
      const topic = await command("upsertTopic", {
        name: "영성",
        parentId: null,
        aliases: [],
        description: "",
        kdcCodes: [],
      });
      const note = await command(
        "addNote",
        { title: "서평", content: "보존할 원래 메모", kind: "thought" },
        "library",
        "/api/library",
      );
      const payload = {
        topicId: topic.id,
        sourceKind: "note",
        sourceId: note.id,
        sourceVersion: "1",
        status: "accepted",
        expectedVersion: existing ? 1 : 0,
      };
      if (existing)
        await command("assignTopic", {
          ...payload,
          status: "suggested",
          expectedVersion: 0,
        });
      await bootstrapReplica({ owner, storage: s, transport });
      await queueReplicaCommand({
        storage: s,
        repository: repo,
        path: "/api/thought-map",
        body: { requestId: crypto.randomUUID(), type: "assignTopic", payload },
      });
      await command(
        "editNote",
        {
          id: note.id,
          expectedVersion: 1,
          title: "서평",
          content: "다른 기기에서 고친 메모",
          kind: "thought",
        },
        "library",
        "/api/library",
      );
      await command("deleteTopic", { id: topic.id, expectedVersion: 1 });
      await pullReplica({ owner, storage: s, transport });
      await expect(
        queueReplicaCommand({
          storage: s,
          repository: repo,
          path: "/api/thought-map",
          body: {
            requestId: crypto.randomUUID(),
            type: "assignTopic",
            payload: { ...payload, expectedVersion: existing ? 2 : 1 },
          },
        }),
      ).rejects.toThrow("삭제한 주제");
      await pushReplica({
        storage: s,
        send: transport.push!,
        pull: async () => {
          await pullReplica({ owner, storage: s, transport });
        },
      });
      const entry = (await s.listOutbox())[0],
        review = await loadReplicaConflict(s, entry.requestId);
      expect((review as any).deletedTopic).toMatchObject({
        id: topic.id,
        name: "영성",
      });
      await expect(
        applyReplicaResolution(s, review, { choice: "mine" }),
      ).rejects.toMatchObject({ status: 409 });
      await applyReplicaResolution(s, review, {
        choice: "mine",
        restoreTopic: true,
      } as any);
      const pending = await s.listOutbox();
      expect(pending.map((e) => (e.command as any).body.type)).toEqual([
        "restoreTopic",
        "assignTopic",
      ]);
      expect(pending[1].dependsOn).toContain(pending[0].requestId);
      await pushReplica({
        storage: s,
        send: transport.push!,
        pull: async () => {
          await pullReplica({ owner, storage: s, transport });
        },
      });
      expect(await s.listConflicts()).toHaveLength(0);
      expect(await s.listOutbox()).toHaveLength(0);
      expect(
        (
          await f.db.query(
            "SELECT archived_at FROM library_topics WHERE id=$1",
            [topic.id],
          )
        ).rows,
      ).toEqual([{ archived_at: null }]);
      expect(
        (
          await f.db.query(
            "SELECT status FROM library_topic_memberships WHERE source_id=$1",
            [note.id],
          )
        ).rows,
      ).toEqual([{ status: "accepted" }]);
      expect(
        (
          await f.db.query("SELECT content FROM library_notes WHERE id=$1", [
            note.id,
          ])
        ).rows,
      ).toEqual([{ content: "다른 기기에서 고친 메모" }]);
    } finally {
      repo.close();
      await f.pg.close();
    }
  });

it("sends a reviewed new note, its topic context and later edits to SQL exactly once and empties the review queue", async () => {
  const f = await testDatabase(),
    owner = "new-conflict-owner",
    s = createMemoryReplica(owner),
    transport = sqlSyncTransport(f.db, owner),
    repo = createReplicaRepository(s);
  try {
    const requestId = crypto.randomUUID();
    const topic: any = await executeSyncCommand(f.db, owner, {
      requestId,
      family: "thought-map",
      path: "/api/thought-map",
      body: {
        requestId,
        type: "upsertTopic",
        payload: {
          name: "사유",
          parentId: null,
          aliases: [],
          description: "",
          kdcCodes: [],
        },
      },
    });
    await bootstrapReplica({ owner, storage: s, transport });
    const queue = (type: string, payload: any, path = "/api/library") =>
      queueReplicaCommand({
        storage: s,
        repository: repo,
        path,
        body: { requestId: crypto.randomUUID(), type, payload },
      });
    const created = await queue("addNote", {
      title: "처음",
      content: "새로 쓴 메모",
      kind: "thought",
      topicChanges: [
        { topicId: topic.id, status: "accepted", expectedVersion: 0 },
      ],
    });
    await queue(
      "assignTopic",
      {
        topicId: topic.id,
        sourceKind: "note",
        sourceId: created.id,
        sourceVersion: "1",
        status: "rejected",
        expectedVersion: 1,
      },
      "/api/thought-map",
    );
    await queue("editNote", {
      id: created.id,
      expectedVersion: 1,
      title: "최종",
      content: "수정한 최종 내용",
      kind: "thought",
      tags: ["내 기록"],
    });
    await pushReplica({
      storage: s,
      send: async () => {
        throw Object.assign(Error("검토 필요"), { status: 409 });
      },
      pull: async () => {},
    });
    const entry = (await s.listOutbox()).find(
      (e) => e.entityId === created.id,
    )!;
    const original = structuredClone(await s.listOutbox());
    const review = await loadReplicaConflict(s, entry.requestId);
    await applyReplicaResolution(s, review, { choice: "mine" });
    expect(await s.listConflicts()).toHaveLength(0);
    const report = await pushReplica({
      storage: s,
      send: transport.push!,
      pull: async () => {
        await pullReplica({ owner, storage: s, transport });
      },
    });
    expect(report.conflicts).toBe(0);
    expect(await s.listOutbox()).toHaveLength(0);
    expect(
      (
        await f.db.query(
          "SELECT id,title,content FROM library_notes WHERE owner_id=$1",
          [owner],
        )
      ).rows,
    ).toEqual([{ id: created.id, title: "최종", content: "수정한 최종 내용" }]);
    expect(
      (
        await f.db.query(
          "SELECT status FROM library_topic_memberships WHERE owner_id=$1 AND source_id=$2",
          [owner, created.id],
        )
      ).rows,
    ).toEqual([{ status: "rejected" }]);
    const history = await s.listConflicts(true);
    expect(history.find((h) => h.resolvedAt)?.resolution.entries).toEqual(
      original.filter((e) => e.entityId === created.id),
    );
  } finally {
    repo.close();
    await f.pg.close();
  }
});
