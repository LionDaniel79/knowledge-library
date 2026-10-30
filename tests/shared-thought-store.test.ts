import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { resourceFixture } from "./helpers/replica-resources";
import { queueReplicaCommand } from "../src/client/replica/outbox";
import { createKnowledgeStore } from "../src/server/knowledge-store";
import { createLibraryStore } from "../src/server/library-store";
import { readThoughtBoxes } from "../src/server/thought-boxes";
import { emptyBoard, WHITEBOARD_ID } from "../src/lib/whiteboard";
import { addThoughtBox } from "../src/lib/thought-boxes";
const cmd = (type: string, payload: any) => ({
  requestId: randomUUID(),
  type,
  payload,
});
it("promotes copies idempotently into an owned independent canonical record with revision history", async () => {
  const f = await testDatabase();
  try {
    const owner = randomUUID(),
      store = createKnowledgeStore(f.db),
      id = randomUUID();
    let data = addThoughtBox(emptyBoard(), id, "원본 상자");
    await store.mutate(
      owner,
      cmd("saveWhiteboard", { data, expectedVersion: 0 }),
    );
    const created = await store.mutate(
      owner,
      cmd("createResearch", { title: "글감", kind: "thesis", question: "" }),
    );
    const copy = addThoughtBox(emptyBoard(), randomUUID(), "원본 상자");
    copy.writing!.chapters[0].sourceBox = {
      boardId: WHITEBOARD_ID,
      chapterId: id,
    };
    copy.writing!.chapters[0].order = 9;
    await store.mutate(
      owner,
      cmd("saveWhiteboard", {
        boardId: created.id,
        data: copy,
        expectedVersion: 0,
      }),
    );
    const action = cmd("promoteThoughtBoxes", {});
    await store.mutate(owner, action);
    await store.mutate(owner, action);
    await store.mutate(owner, cmd("promoteThoughtBoxes", {}));
    expect(
      (await readThoughtBoxes(f.db, owner)).items.map((x) => x.title),
    ).toEqual(["원본 상자"]);
    const row = (
      await f.db.query(
        "SELECT data FROM library_whiteboards WHERE owner_id=$1 AND id=$2",
        [owner, created.id],
      )
    ).rows[0];
    expect(row.data.writing.chapters[0]).toMatchObject({
      bundleId: id,
      order: 9,
    });
    expect(
      (
        await f.db.query(
          "SELECT count(*)::int n FROM library_memo_bundles WHERE owner_id=$1",
          [owner],
        )
      ).rows[0].n,
    ).toBe(1);
    expect((await readThoughtBoxes(f.db, "foreign")).items).toHaveLength(0);
    expect(
      (
        await f.db.query(
          "SELECT count(*)::int n FROM library_revisions WHERE owner_id=$1 AND action='saveWhiteboard'",
          [owner],
        )
      ).rows[0].n,
    ).toBeGreaterThan(2);
  } finally {
    await f.pg.close();
  }
});
it("the device promotes old boxes into the same original without a server or duplicate queued commands", async () => {
  const f = await resourceFixture();
  try {
    const id = randomUUID();
    await queueReplicaCommand({
      storage: f.s,
      repository: f.repo,
      path: "/api/knowledge",
      body: cmd("saveWhiteboard", {
        data: addThoughtBox(emptyBoard(), id, "로컬 원본"),
        expectedVersion: 0,
      }),
    });
    await queueReplicaCommand({
      storage: f.s,
      repository: f.repo,
      path: "/api/knowledge",
      body: cmd("promoteThoughtBoxes", {}),
    });
    const result: any = await f.repo.read("/api/thought-boxes");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ id, title: "로컬 원본" });
    expect(result.pendingLegacy).toBe(false);
  } finally {
    f.repo.close();
  }
});
it("requires explicit confirmation for late legacy-only memos and records the merge without a second original", async () => {
  const f = await testDatabase();
  try {
    const owner = randomUUID(),
      store = createKnowledgeStore(f.db),
      library = createLibraryStore(f.db);
    const ids: string[] = [];
    for (const content of ["기존 메모", "늦게 추가한 메모"])
      ids.push((await library.mutate(owner, cmd("addNote", { content }))).id!);
    const canonical = await store.mutate(
      owner,
      cmd("saveMemoBundle", {
        title: "최근 원본",
        description: "보존할 원본 내용",
        noteIds: [ids[0]],
        expectedVersion: 0,
      }),
    );
    const data = addThoughtBox(emptyBoard(), randomUUID(), "옛 사본");
    data.writing!.chapters[0].sourceBox = {
      boardId: WHITEBOARD_ID,
      chapterId: canonical.id!,
    };
    data.writing!.chapters[0].items = ids.map((id, i) => ({
      id: randomUUID(),
      order: i + 1,
      kind: "note",
      label: "메모",
      noteIds: [id],
      groupIds: [],
    }));
    await store.mutate(
      owner,
      cmd("saveWhiteboard", { expectedVersion: 0, data }),
    );
    const inventory = await readThoughtBoxes(f.db, owner);
    expect(inventory.legacyConflicts).toHaveLength(1);
    await expect(
      store.mutate(owner, cmd("promoteThoughtBoxes", {})),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (
        await f.db.query(
          "SELECT data FROM library_whiteboards WHERE owner_id=$1",
          [owner],
        )
      ).rows[0].data.writing.chapters[0].items,
    ).toHaveLength(2);
    const request = cmd("promoteThoughtBoxes", {
      legacyToken: inventory.legacyToken,
    });
    await store.mutate(owner, request);
    await store.mutate(owner, request);
    const originals = (
      await f.db.query("SELECT * FROM library_memo_bundles WHERE owner_id=$1", [
        owner,
      ])
    ).rows;
    expect(originals).toHaveLength(1);
    expect(originals[0]).toMatchObject({
      title: "최근 원본",
      description: "보존할 원본 내용",
      note_ids: ids,
      version: 2,
    });
    expect((await readThoughtBoxes(f.db, owner)).pendingLegacy).toBe(false);
    expect(
      (
        await f.db.query(
          "SELECT action FROM library_revisions WHERE owner_id=$1 AND action='mergeLegacyThoughtBoxes'",
          [owner],
        )
      ).rows,
    ).toHaveLength(1);
  } finally {
    await f.pg.close();
  }
});
