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
