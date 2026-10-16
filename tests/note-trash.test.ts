import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { createLibraryStore } from "../src/server/library-store";
import { readCurationSource } from "../src/server/curation-store";
import { createCurationStore } from "../src/server/curation-store";
import { createKnowledgeStore } from "../src/server/knowledge-store";
import { searchLibrary } from "../src/server/library-search";
import {
  createLibraryBackup,
  restoreLibraryBackup,
} from "../src/server/library-backup";
let f: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  f = await testDatabase();
});
afterAll(async () => {
  await f?.pg.close();
});
it("hides both deleted connection endpoints and restores current auxiliary metadata", async () => {
  const s = createLibraryStore(f.db),
    k = createKnowledgeStore(f.db),
    c = createCurationStore(f.db),
    owner = "trash-links";
  const cmd = (type: string, payload: unknown) => ({
    requestId: randomUUID(),
    type,
    payload,
  });
  const a = await s.mutate(
    owner,
    cmd("addNote", { title: "앞 기록", content: "감정을 이해한다." }),
  );
  const b = await s.mutate(
    owner,
    cmd("addNote", { title: "뒤 기록", content: "생각 기록" }),
  );
  const link = await k.mutate(
    owner,
    cmd("connect", {
      sourceKind: "note",
      sourceId: b.id,
      targetKind: "note",
      targetId: a.id,
      relation: "related",
      reason: "고유연결근거",
    }),
  );
  const run = await c.begin(owner, "test-scope", "test"),
    itemId = randomUUID();
  await c.apply(owner, run, [
    {
      id: itemId,
      source: { kind: "note", id: a.id, version: "1" },
      kind: "tag",
      proposedValue: "고유검색태그",
      evidence: { quote: "감정", start: 0, end: 2 },
      coverage: "full",
      origin: "rule",
      generator: "test",
    },
  ]);
  await c.seal(owner, run);
  const topic = randomUUID(),
    membership = randomUUID();
  await f.db.query(
    "INSERT INTO library_topics(id,owner_id,name) VALUES($1,$2,'감정')",
    [topic, owner],
  );
  await f.db.query(
    "INSERT INTO library_topic_memberships(id,owner_id,topic_id,source_kind,source_id,source_version,status,method) VALUES($1,$2,$3,'note',$4,'1','accepted','manual')",
    [membership, owner, topic, a.id],
  );
  await s.mutate(owner, cmd("deleteNote", { id: a.id, expectedVersion: 1 }));
  expect((await k.snapshot(owner)).connections).toHaveLength(0);
  expect(
    (await searchLibrary(f.db, owner, { text: "고유연결근거", layer: "all" }))
      .items,
  ).toHaveLength(0);
  await expect(
    k.mutate(
      owner,
      cmd("editConnection", {
        id: link.id,
        expectedVersion: 1,
        status: "accepted",
        relation: "related",
        reason: "고유연결근거",
      }),
    ),
  ).rejects.toThrow();
  await s.mutate(owner, cmd("restoreNote", { id: a.id, expectedVersion: 2 }));
  expect((await k.snapshot(owner)).connections).toHaveLength(1);
  expect(
    (
      await searchLibrary(f.db, owner, {
        text: "고유검색태그",
        layer: "auxiliary",
      })
    ).items,
  ).toHaveLength(1);
  expect(
    (
      await f.db.query(
        "SELECT source_version FROM library_topic_memberships WHERE id=$1",
        [membership],
      )
    ).rows[0].source_version,
  ).toBe("3");
  expect((await c.list(owner, "note", a.id))[0].source_stale).toBe(false);
});
it("moves a note to trash, excludes it from retrieval, keeps history and restores once", async () => {
  const s = createLibraryStore(f.db),
    owner = "trash-owner";
  const n = await s.mutate(owner, {
    requestId: randomUUID(),
    type: "addNote",
    payload: {
      title: "감정 기록",
      content: "감정을 이해한다.",
      kind: "thought",
    },
  });
  const command = {
    requestId: randomUUID(),
    type: "deleteNote",
    payload: { id: n.id, expectedVersion: 1 },
  };
  await expect(s.mutate("other-owner", command)).rejects.toThrow();
  await expect(
    s.mutate(owner, {
      ...command,
      requestId: randomUUID(),
      payload: { ...command.payload, expectedVersion: 2 },
    }),
  ).rejects.toThrow();
  expect(await s.mutate(owner, command)).toEqual({ id: n.id, version: 2 });
  expect(await s.mutate(owner, command)).toEqual({ id: n.id, version: 2 });
  expect((await s.snapshot(owner)).notes).toHaveLength(0);
  expect((await s.snapshot(owner)).deletedNotes?.[0].content).toBe(
    "감정을 이해한다.",
  );
  expect(
    (await searchLibrary(f.db, owner, { text: "감정", layer: "all" })).items,
  ).toHaveLength(0);
  await expect(
    readCurationSource(f.db, owner, { kind: "note", id: n.id, version: "2" }),
  ).rejects.toThrow();
  await expect(
    s.mutate(owner, {
      requestId: randomUUID(),
      type: "editNote",
      payload: {
        id: n.id,
        expectedVersion: 2,
        title: "수정",
        content: "다른 글",
      },
    }),
  ).rejects.toThrow();
  const backup = await createLibraryBackup(f.db, owner);
  const restored = await testDatabase();
  try {
    await restoreLibraryBackup(restored.db, "restored-trash-owner", backup);
    const restoredSnapshot = await createLibraryStore(restored.db).snapshot(
      "restored-trash-owner",
    );
    expect(restoredSnapshot.notes).toHaveLength(0);
    expect(restoredSnapshot.deletedNotes).toHaveLength(1);
  } finally {
    await restored.pg.close();
  }
  await s.mutate(owner, {
    requestId: randomUUID(),
    type: "restoreNote",
    payload: { id: n.id, expectedVersion: 2 },
  });
  expect((await s.snapshot(owner)).notes[0].content).toBe("감정을 이해한다.");
  expect((await s.snapshot(owner)).deletedNotes).toHaveLength(0);
  expect((await s.revisions(owner, n.id)).map((x) => x.action)).toEqual([
    "addNote",
    "deleteNote",
    "restoreNote",
  ]);
});
