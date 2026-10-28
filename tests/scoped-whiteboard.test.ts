import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { resourceFixture } from "./helpers/replica-resources";
import { queueReplicaCommand } from "../src/client/replica/outbox";
import { createKnowledgeStore } from "../src/server/knowledge-store";
import { createLibraryStore } from "../src/server/library-store";
import {
  readWhiteboard,
  readWhiteboardVisibility,
} from "../src/server/whiteboard-store";
import {
  createLibraryBackup,
  restoreLibraryBackup,
} from "../src/server/library-backup";
import { emptyBoard, WHITEBOARD_ID } from "../src/lib/whiteboard";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  fixture = await testDatabase();
});
afterAll(async () => {
  await fixture?.pg.close();
});
const command = (type: string, payload: unknown) => ({
  requestId: randomUUID(),
  type,
  payload,
});
async function project(owner: string, title: string) {
  return (
    await createKnowledgeStore(fixture.db).mutate(
      owner,
      command("createResearch", { title, question: "", kind: "thesis" }),
    )
  ).id!;
}

it("keeps independent project layouts and versions while retaining the default whiteboard", async () => {
  const owner = randomUUID(),
    store = createKnowledgeStore(fixture.db),
    first = await project(owner, "첫 글감"),
    second = await project(owner, "둘째 글감");
  for (const [boardId, q, x] of [
    [undefined, "기존 보드", 11],
    [first, "첫 배치", -120000],
    [second, "둘째 배치", 85000],
  ] as const) {
    const data = emptyBoard();
    data.filter.q = q;
    data.positions["saved-card"] = { x, y: 37 };
    expect(
      await store.mutate(
        owner,
        command("saveWhiteboard", { boardId, data, expectedVersion: 0 }),
      ),
    ).toMatchObject({ id: boardId ?? WHITEBOARD_ID, version: 1 });
  }
  expect((await readWhiteboard(fixture.db, owner)).board?.data.filter.q).toBe(
    "기존 보드",
  );
  expect((await readWhiteboard(fixture.db, owner, first)).board).toMatchObject({
    id: first,
    version: 1,
    data: {
      filter: { q: "첫 배치" },
      positions: { "saved-card": { x: -120000, y: 37 } },
    },
  });
  expect(
    (await readWhiteboard(fixture.db, owner, second)).board?.data.filter.q,
  ).toBe("둘째 배치");
  await expect(
    store.mutate(
      owner,
      command("saveWhiteboard", {
        boardId: first,
        data: emptyBoard(),
        expectedVersion: 0,
      }),
    ),
  ).rejects.toMatchObject({ status: 409 });
  const foreign = await project(randomUUID(), "다른 계정 글감");
  for (const boardId of [foreign, randomUUID()]) {
    await expect(
      store.mutate(
        owner,
        command("saveWhiteboard", {
          boardId,
          data: emptyBoard(),
          expectedVersion: 0,
        }),
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      readWhiteboard(fixture.db, owner, boardId),
    ).rejects.toMatchObject({ status: 404 });
  }
});

it("scopes project visibility without changing the note inspector's default board", async () => {
  const owner = randomUUID(),
    store = createKnowledgeStore(fixture.db),
    boardId = await project(owner, "숨김을 따로 보존"),
    noteId = (
      await createLibraryStore(fixture.db).mutate(
        owner,
        command("addNote", { content: "원래 메모" }),
      )
    ).id!;
  await store.mutate(
    owner,
    command("setWhiteboardNoteVisibility", { boardId, noteId, visible: false }),
  );
  expect(await readWhiteboardVisibility(fixture.db, owner, noteId)).toEqual({
    visible: true,
  });
  expect(
    await readWhiteboardVisibility(fixture.db, owner, noteId, boardId),
  ).toEqual({ visible: false });
  expect((await readWhiteboard(fixture.db, owner)).board).toBeNull();
  await store.mutate(
    owner,
    command("setWhiteboardNotesVisibility", {
      boardId,
      noteIds: [noteId],
      visible: true,
    }),
  );
  expect(
    (await readWhiteboard(fixture.db, owner, boardId)).board?.version,
  ).toBe(2);
});

it("queues and restores scoped layouts offline and rejects unavailable projects", async () => {
  const f = await resourceFixture();
  const queue = (type: string, payload: unknown) =>
    queueReplicaCommand({
      storage: f.s,
      repository: f.repo,
      path: "/api/knowledge",
      body: command(type, payload),
    });
  try {
    const data = emptyBoard();
    data.filter.q = "글감 전용 검색";
    data.positions["saved-card"] = { x: -500, y: 900 };
    await queue("saveWhiteboard", {
      boardId: f.research,
      data,
      expectedVersion: 0,
    });
    await queue("setWhiteboardNotesVisibility", {
      boardId: f.research,
      noteIds: [f.note],
      visible: false,
    });
    expect(
      await f.repo.raw("library_whiteboards", WHITEBOARD_ID),
    ).toBeUndefined();
    expect(
      await f.repo.read(`/api/whiteboard?view=visibility&noteId=${f.note}`),
    ).toEqual({ visible: true });
    expect(
      await f.repo.read(
        `/api/whiteboard?view=visibility&noteId=${f.note}&boardId=${f.research}`,
      ),
    ).toEqual({ visible: false });
    const read = (await f.repo.read(
      `/api/whiteboard?boardId=${f.research}`,
    )) as any;
    expect(read.board).toMatchObject({
      id: f.research,
      version: 2,
      data: {
        filter: { q: "글감 전용 검색" },
        positions: { "saved-card": { x: -500, y: 900 } },
      },
    });
    expect(((await f.repo.read("/api/whiteboard")) as any).board).toBeNull();
    await expect(
      queue("saveWhiteboard", {
        boardId: randomUUID(),
        data,
        expectedVersion: 0,
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      f.repo.read(`/api/whiteboard?boardId=${randomUUID()}`),
    ).rejects.toMatchObject({ status: 404 });
    const effects = (await f.s.listOutbox()).map((e) =>
      (e.command as any).effects.find(
        (effect: any) => effect.entity === "library_whiteboards",
      ),
    );
    expect(effects.map((e) => e.after.id)).toEqual([f.research, f.research]);
  } finally {
    f.repo.close();
  }
});

it("round trips project boards together with their existing research assets", async () => {
  const owner = randomUUID(),
    boardId = await project(owner, "복원할 글감"),
    data = emptyBoard(),
    target = await testDatabase();
  try {
    data.positions["saved-card"] = { x: 321, y: -654 };
    await createKnowledgeStore(fixture.db).mutate(
      owner,
      command("saveWhiteboard", { boardId, data, expectedVersion: 0 }),
    );
    const backup = await createLibraryBackup(fixture.db, owner);
    await restoreLibraryBackup(target.db, "restored", backup);
    expect(
      (await readWhiteboard(target.db, "restored", boardId)).board,
    ).toMatchObject({
      id: boardId,
      data: { positions: { "saved-card": { x: 321, y: -654 } } },
    });
    expect(
      (await createKnowledgeStore(target.db).snapshot("restored")).research.map(
        (p) => p.id,
      ),
    ).toEqual([boardId]);
  } finally {
    await target.pg.close();
  }
});
