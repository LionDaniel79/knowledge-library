import { it, expect, vi } from "vitest";
import { resourceFixture } from "./helpers/replica-resources";
import { queueReplicaCommand } from "../src/client/replica/outbox";
import { emptyBoard, WHITEBOARD_ID } from "../src/lib/whiteboard";
import { boardSaveSchema } from "../src/lib/whiteboard";
import {
  loadReplicaConflict,
  applyReplicaResolution,
} from "../src/client/replica/conflicts";
import { pushReplica } from "../src/client/replica/push";
import { sha256Bytes } from "../src/lib/replica/codec";
import { testDatabase } from "./helpers/database";
import { createLibraryStore } from "../src/server/library-store";
import { createKnowledgeStore } from "../src/server/knowledge-store";
it("queues visibility offline, answers a small direct lookup and preserves it across an older layout save", async () => {
  const f = await resourceFixture();
  const queue = (type: string, payload: unknown) =>
    queueReplicaCommand({
      storage: f.s,
      repository: f.repo,
      path: "/api/knowledge",
      body: { requestId: crypto.randomUUID(), type, payload },
    });
  try {
    await queue("setWhiteboardNoteVisibility", {
      noteId: f.note,
      visible: false,
    });
    const same = await queue("setWhiteboardNoteVisibility", {
      noteId: f.note,
      visible: false,
    });
    expect(same.version).toBe(1);
    const scans = vi.spyOn(f.s, "readPage");
    expect(
      await f.repo.read(`/api/whiteboard?view=visibility&noteId=${f.note}`),
    ).toEqual({ visible: false });
    expect(scans).not.toHaveBeenCalled();
    const old = emptyBoard();
    old.hiddenNoteIds = [];
    old.filter.q = "이전 버전에서 바꾼 배치";
    await queue("saveWhiteboard", { data: old, expectedVersion: 1 });
    expect(
      (await f.repo.raw("library_whiteboards", WHITEBOARD_ID))?.data
        .hiddenNoteIds,
    ).toEqual([f.note]);
    await queue("setWhiteboardNoteVisibility", {
      noteId: f.note,
      visible: true,
    });
    expect(
      await f.repo.read(`/api/whiteboard?view=visibility&noteId=${f.note}`),
    ).toEqual({ visible: true });
    expect((await f.repo.note(f.note)).content).toBe(
      "정보와 신뢰를 함께 생각한다",
    );
    expect(await f.s.listOutbox()).toHaveLength(4);
  } finally {
    f.repo.close();
  }
});
it("keeping a layout conflict ending in visibility retains the complete local board under a valid reviewed command", async () => {
  const f = await resourceFixture();
  const queue = (type: string, payload: unknown) =>
    queueReplicaCommand({
      storage: f.s,
      repository: f.repo,
      path: "/api/knowledge",
      body: { requestId: crypto.randomUUID(), type, payload },
    });
  try {
    const board = emptyBoard();
    board.filter.q = "PC의 배치";
    await queue("saveWhiteboard", { data: board, expectedVersion: 0 });
    await queue("setWhiteboardNoteVisibility", {
      noteId: f.note,
      visible: false,
    });
    await queue("setWhiteboardNoteVisibility", {
      noteId: f.note,
      visible: false,
    });
    const server = {
      id: WHITEBOARD_ID,
      data: {
        ...emptyBoard(),
        filter: { ...board.filter, q: "다른 곳의 배치" },
      },
      version: 4,
    };
    const cp = (await f.s.checkpoint())!,
      inline = JSON.stringify(server),
      bytes = new TextEncoder().encode(inline);
    await f.s.stageRows(cp.generation, [
      {
        entity: "library_whiteboards",
        key: JSON.stringify([WHITEBOARD_ID]),
        revision: "4",
        deleted: false,
        inline,
        bytes: bytes.length,
        sha256: await sha256Bytes(bytes),
      },
    ]);
    await pushReplica({
      storage: f.s,
      send: async () => {
        throw Object.assign(Error("conflict"), { status: 409 });
      },
      pull: async () => {},
    });
    const original = (await f.s.listOutbox())[0],
      review = await loadReplicaConflict(f.s, original.requestId);
    expect(review.local.data.hiddenNoteIds).toEqual([f.note]);
    await applyReplicaResolution(f.s, review, { choice: "mine" });
    const remaining = await f.s.listOutbox(),
      body = (remaining[0].command as any).body;
    expect(remaining).toHaveLength(1);
    expect(body.type).toBe("saveWhiteboard");
    expect(body.payload).toMatchObject({
      expectedVersion: 4,
      includeVisibility: true,
      data: { filter: { q: "PC의 배치" }, hiddenNoteIds: [f.note] },
    });
    expect(boardSaveSchema.safeParse(body.payload).success).toBe(true);
    expect((await f.s.listConflicts(true))[0].resolution.entries).toHaveLength(
      3,
    );
  } finally {
    f.repo.close();
  }
});
it("pushes an unchanged visibility command followed by a layout without a false version conflict", async () => {
  const f = await resourceFixture(),
    db = await testDatabase();
  try {
    const library = createLibraryStore(db.db),
      knowledge = createKnowledgeStore(db.db);
    const added = await library.mutate("resources", {
      requestId: crypto.randomUUID(),
      entityId: f.note,
      type: "addNote",
      payload: { content: "검사용 메모" },
    });
    expect(added.id).toBe(f.note);
    const queue = (type: string, payload: unknown) =>
      queueReplicaCommand({
        storage: f.s,
        repository: f.repo,
        path: "/api/knowledge",
        body: { requestId: crypto.randomUUID(), type, payload },
      });
    expect(
      (
        await queue("setWhiteboardNoteVisibility", {
          noteId: f.note,
          visible: true,
        })
      ).version,
    ).toBe(0);
    await queue("saveWhiteboard", { data: emptyBoard(), expectedVersion: 0 });
    const report = await pushReplica({
      storage: f.s,
      send: (entry) =>
        knowledge.mutate("resources", (entry.command as any).body),
      pull: async () => {},
    });
    expect(report).toMatchObject({
      confirmed: 2,
      conflicts: 0,
      failed: 0,
      remaining: 0,
    });
  } finally {
    f.repo.close();
    await db.pg.close();
  }
});
