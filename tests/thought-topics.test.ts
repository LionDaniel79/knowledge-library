import { it, expect, beforeAll, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createLibraryStore, type Database } from "../src/server/library-store";
import { createThoughtMapStore } from "../src/server/thought-map-store";
let pg: PGlite,
  store: ReturnType<typeof createThoughtMapStore>,
  library: ReturnType<typeof createLibraryStore>;
const cmd = (type: string, payload: unknown) => ({
  requestId: randomUUID(),
  type,
  payload,
});
const topic = (name: string, parentId: string | null = null) => ({
  name,
  parentId,
  aliases: ["같은 별칭"],
  description: "설명",
  kdcCodes: [],
});
beforeAll(async () => {
  pg = new PGlite();
  for (const f of [
    "001_library",
    "002_ireaditnow",
    "003_reading_history",
    "004_pdf_library",
    "005_knowledge",
    "006_catalog",
    "007_thought_map",
    "008_thought_jobs",
    "009_analysis_devices",
    "010_library_ai_policy",
    "011_library_curation",
    "012_library_assist",
    "013_pdf_processing_scope",
    "015_book_relations",
    "016_research_organization",
    "017_note_trash",
  ])
    await pg.exec(await readFile(`db/${f}.sql`, "utf8"));
  const db: Database = {
    query: (s, p = []) => pg.query(s, p),
    transaction: (fn) =>
      pg.transaction((tx) => fn({ query: (s, p = []) => tx.query(s, p) })),
  };
  store = createThoughtMapStore(db);
  library = createLibraryStore(db);
});
afterAll(async () => {
  await pg?.close();
});
it("proposes topics from existing tags without silently confirming or restoring rejected memberships", async () => {
  const n = await library.mutate(
    "tags",
    cmd("addNote", {
      title: "정서",
      content: "느낌",
      kind: "thought",
      tags: ["정서"],
    }),
  );
  await store.mutate("tags", cmd("proposeTopics", {}));
  let state = await store.snapshot("tags");
  expect(state.topics[0]).toMatchObject({ name: "정서", confirmed: false });
  expect(state.memberships[0].status).toBe("suggested");
  await store.mutate(
    "tags",
    cmd("assignTopic", {
      topicId: state.topics[0].id,
      sourceKind: "note",
      sourceId: n.id,
      sourceVersion: "1",
      status: "rejected",
      expectedVersion: 1,
    }),
  );
  await store.mutate("tags", cmd("proposeTopics", {}));
  state = await store.snapshot("tags");
  expect(state.topics).toHaveLength(1);
  expect(state.memberships[0].status).toBe("rejected");
});
it("rejects cycles and fourth-level parenting without merging ambiguous aliases", async () => {
  const a = await store.mutate("a", cmd("upsertTopic", topic("상담"))),
    b = await store.mutate("a", cmd("upsertTopic", topic("정서", a.id))),
    c = await store.mutate("a", cmd("upsertTopic", topic("수용", b.id)));
  await expect(
    store.mutate(
      "a",
      cmd("upsertTopic", {
        ...topic("상담", b.id),
        id: a.id,
        expectedVersion: 1,
      }),
    ),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    store.mutate("a", cmd("upsertTopic", topic("넷째", c.id))),
  ).rejects.toMatchObject({ status: 400 });
  expect((await store.snapshot("a")).topics).toHaveLength(3);
  await expect(
    store.mutate("b", cmd("upsertTopic", topic("외부", a.id))),
  ).rejects.toMatchObject({ status: 404 });
});
it("keeps multiple topics and reviewed rejections across automatic reruns", async () => {
  const a = await store.mutate("multi", cmd("upsertTopic", topic("상담"))),
    b = await store.mutate("multi", cmd("upsertTopic", topic("신학")));
  const n = await library.mutate(
    "multi",
    cmd("addNote", { title: "정서", content: "느낀 생각", kind: "thought" }),
  );
  const assign = {
    topicId: a.id,
    sourceKind: "note",
    sourceId: n.id,
    sourceVersion: "1",
    status: "accepted",
  };
  await store.mutate("multi", cmd("assignTopic", assign));
  await store.mutate(
    "multi",
    cmd("assignTopic", { ...assign, topicId: b.id, status: "rejected" }),
  );
  await store.mutate(
    "multi",
    cmd("assignTopic", { ...assign, topicId: b.id, status: "suggested" }),
  );
  const state = await store.snapshot("multi");
  expect(state.memberships.map((m) => m.status).sort()).toEqual([
    "accepted",
    "rejected",
  ]);
  await expect(
    store.mutate("foreign", cmd("assignTopic", assign)),
  ).rejects.toMatchObject({ status: 404 });
  const exported = await library.exportLibrary("multi");
  expect(exported.schemaVersion).toBe(6);
  expect(exported.thoughtMap.topics).toHaveLength(2);
});
