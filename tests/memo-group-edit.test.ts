import { it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { createLibraryStore } from "../src/server/library-store";
import { createKnowledgeStore } from "../src/server/knowledge-store";
import { readWhiteboard } from "../src/server/whiteboard-store";
import { connectedMemoGroups } from "../src/lib/memo-box";
import { emptyBoard, type WhiteboardSnapshot } from "../src/lib/whiteboard";
import { planMemoGroupEdit } from "../src/lib/memo-group-edit";
import { prepareOptimistic } from "../src/client/replica/optimistic";
import type { ReplicaRepository } from "../src/client/replica/repository";
import { WHITEBOARD_ID } from "../src/lib/whiteboard";
import { createAssistStore } from "../src/server/assist-store";
let fixture: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  fixture = await testDatabase();
});
afterAll(async () => {
  await fixture?.pg.close();
});
const cmd = (type: string, payload: unknown) => ({
  requestId: randomUUID(),
  type,
  payload,
});
it("atomically saves group and pair fields, retries safely, and splits only the top level", async () => {
  const { db } = fixture,
    owner = randomUUID(),
    library = createLibraryStore(db),
    store = createKnowledgeStore(db);
  const ids: string[] = [];
  for (const title of ["A", "B", "C"])
    ids.push(
      (
        await library.mutate(
          owner,
          cmd("addNote", { title, content: title + " 원문" }),
        )
      ).id!,
    );
  for (const [a, b] of [
    [0, 1],
    [1, 2],
  ])
    await store.mutate(
      owner,
      cmd("connect", {
        sourceKind: "note",
        sourceId: ids[a],
        targetKind: "note",
        targetId: ids[b],
        relation: "related",
        reason: "기존 연결",
      }),
    );
  let source = (await readWhiteboard(
    db,
    owner,
  )) as unknown as WhiteboardSnapshot;
  const beforeNotes = structuredClone(source.notes);
  let group = connectedMemoGroups(source)[0];
  const payload = {
    expectedBoardVersion: 0,
    title: "전체 연결 제목",
    reason: "전체 연결 이유",
    connections: group.connections.map((c, i) => ({
      id: c.id,
      expectedVersion: c.version,
      title: "연결 " + i,
      reason: "이유 " + i,
    })),
  };
  const save = cmd("editMemoGroup", payload);
  await store.mutate(owner, save);
  await store.mutate(owner, save);
  source = (await readWhiteboard(db, owner)) as unknown as WhiteboardSnapshot;
  group = connectedMemoGroups(source)[0];
  expect(group.title).toBe("전체 연결 제목");
  expect(group.reason).toBe("전체 연결 이유");
  expect(source.connections.every((c) => c.version === 2)).toBe(true);
  expect(source.notes).toEqual(beforeNotes);
  await store.mutate(
    owner,
    cmd("saveWhiteboard", {
      expectedVersion: source.board!.version,
      data: emptyBoard(),
    }),
  );
  source = (await readWhiteboard(db, owner)) as unknown as WhiteboardSnapshot;
  expect(connectedMemoGroups(source)[0].title).toBe("전체 연결 제목");
  const state = structuredClone(source);
  await expect(
    store.mutate(
      owner,
      cmd("editMemoGroup", {
        ...payload,
        expectedBoardVersion: source.board!.version,
        connections: payload.connections.map((c, i) => ({
          ...c,
          expectedVersion: i ? 1 : 2,
          title: "실패한 수정",
        })),
      }),
    ),
  ).rejects.toMatchObject({ status: 409 });
  source = (await readWhiteboard(db, owner)) as unknown as WhiteboardSnapshot;
  expect(source).toEqual(state);
  await store.mutate(
    owner,
    cmd("editMemoGroup", {
      ...payload,
      expectedBoardVersion: source.board!.version,
      connections: source.connections.map((c) => ({
        id: c.id,
        expectedVersion: c.version,
        title: c.title ?? "",
        reason: c.reason,
      })),
      split: true,
    }),
  );
  source = (await readWhiteboard(db, owner)) as unknown as WhiteboardSnapshot;
  const children = connectedMemoGroups(source);
  expect(children).toHaveLength(2);
  expect(children.map((g) => g.notes.length)).toEqual([2, 2]);
  expect(source.connections).toEqual(state.connections);
  expect(source.notes).toEqual(beforeNotes);
  const pair = children[0];
  await store.mutate(
    owner,
    cmd("editMemoGroup", {
      expectedBoardVersion: source.board!.version,
      title: pair.title,
      reason: pair.reason ?? "",
      connections: pair.connections.map((c) => ({
        id: c.id,
        expectedVersion: c.version,
        title: c.title ?? "",
        reason: c.reason,
      })),
      split: true,
    }),
  );
  source = (await readWhiteboard(db, owner)) as unknown as WhiteboardSnapshot;
  expect(connectedMemoGroups(source)).toHaveLength(1);
  expect(
    source.connections.filter((c) => c.status === "accepted"),
  ).toHaveLength(1);
  expect(source.notes).toEqual(beforeNotes);
});
it("retains a prior multi-edge child when a higher-level group is split and ignores orphan metadata", () => {
  const [a, b, c, d] = Array.from({ length: 4 }, () => randomUUID());
  const edges = [
    [a, b],
    [b, c],
    [c, d],
  ].map(([source_id, target_id]) => ({
    id: randomUUID(),
    source_kind: "note",
    target_kind: "note",
    source_id,
    target_id,
    status: "accepted",
    relation: "related",
    reason: "원래 이유",
    title: "하위 제목",
    version: 1,
    method: "manual",
  }));
  const data = {
    ...emptyBoard(),
    memoGroups: [
      {
        connectionIds: edges.slice(0, 2).map((e) => e.id),
        title: "기존 두 연결",
        reason: "기존 전체 이유",
        children: edges.slice(0, 2).map((e) => [e.id]),
      },
    ],
  };
  const source = {
    notes: [a, b, c, d].map((id) => ({ id, title: id })),
    connections: edges,
    board: { id: randomUUID(), version: 1, data },
  } as unknown as WhiteboardSnapshot;
  const merged = connectedMemoGroups(source)[0];
  expect(merged.children!.map((c) => c.length).sort()).toEqual([1, 2]);
  const result = planMemoGroupEdit(data, edges, {
    expectedBoardVersion: 1,
    connections: edges.map((e) => ({
      id: e.id,
      expectedVersion: 1,
      title: e.title,
      reason: e.reason,
    })),
    children: merged.children,
    title: "상위",
    reason: "상위 이유",
    split: true,
  });
  const split = connectedMemoGroups({
    ...source,
    board: { ...source.board!, data: result.data },
  });
  expect(split.map((g) => g.connections.length).sort()).toEqual([1, 2]);
  expect(split.find((g) => g.connections.length === 2)?.title).toBe(
    "기존 두 연결",
  );
  expect(result.changes).toEqual([]);
  expect(connectedMemoGroups({ ...source, connections: [] })).toEqual([]);
});
it("queues a split atomically in the offline replica without rejecting either edge", async () => {
  const [a, b, c] = Array.from({ length: 3 }, () => randomUUID());
  const rows = [
    [a, b],
    [b, c],
  ].map(([source_id, target_id]) => ({
    id: randomUUID(),
    source_id,
    target_id,
    source_kind: "note",
    target_kind: "note",
    title: "기존 제목",
    reason: "기존 이유",
    status: "accepted",
    relation: "related",
    method: "manual",
    version: 1,
  }));
  const repo = {
    raw: async (entity: string, id: string) =>
      entity === "library_connections"
        ? rows.find((c) => c.id === id)
        : entity === "library_notes"
          ? { id, version: 1 }
          : entity === "library_whiteboards"
            ? { id: WHITEBOARD_ID, data: emptyBoard(), version: 2 }
            : undefined,
  } as ReplicaRepository;
  const result = await prepareOptimistic(
    repo,
    "/api/knowledge",
    cmd("editMemoGroup", {
      expectedBoardVersion: 2,
      connections: rows.map((c) => ({
        id: c.id,
        expectedVersion: 1,
        title: c.title,
        reason: c.reason,
      })),
      title: "전체",
      reason: "전체 이유",
      split: true,
    }),
    "2026-11-14T00:00:00Z",
  );
  expect(
    result.effects.filter((e) => e.entity === "library_connections"),
  ).toEqual([]);
  const board = result.effects.find(
    (e) => e.entity === "library_whiteboards",
  )!.after!;
  expect(board.version).toBe(3);
  expect(board.data.memoGroups).toHaveLength(2);
  expect(rows.every((c) => c.status === "accepted" && c.version === 1)).toBe(
    true,
  );
});
it("stores single-note title requests with exact editor scope and preserves budget policy", async () => {
  const owner = randomUUID(),
    library = createLibraryStore(fixture.db),
    assist = createAssistStore(fixture.db);
  const note = await library.mutate(
    owner,
    cmd("addNote", { title: "기존 제목", content: "성찰을 위한 원문입니다." }),
  );
  await assist.configure(owner, {
    expectedPolicyVersion: 0,
    requestsEnabled: true,
    requestLimitUsd: "0.5",
    runtimeMonthlyLimitUsd: "1",
    developmentLimitUsd: null,
  });
  const editorContext = { kind: "note", id: note.id!, noteIds: [note.id!] };
  const selection = {
    purpose: "synthesis",
    focus: "editor_title",
    editorContext,
    recordsOnly: true,
    sources: [{ source: { kind: "note", id: note.id!, version: "1" } }],
  };
  const preview = await assist.preview(owner, selection);
  expect(
    "editorContext" in preview.task.payload
      ? preview.task.payload.editorContext
      : null,
  ).toEqual(editorContext);
  await assist.request(owner, {
    ...selection,
    requestId: randomUUID(),
    expectedPolicyVersion: preview.policy.version,
    scopeHash: preview.scopeHash,
  });
  const state = await assist.status(owner, { compact: true });
  expect(state.requests[0].scope.editorContext).toEqual(editorContext);
  expect(state.requests[0].scope.sources).toHaveLength(1);
  expect(state.policy.requestLimitUsd).toBe(preview.policy.requestLimitUsd);
});
