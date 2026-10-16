import { it, expect, beforeAll, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createLibraryStore, type Database } from "../src/server/library-store";
import { createThoughtMapStore } from "../src/server/thought-map-store";
import { resolveThoughtRecord } from "../src/lib/thought-map/records";
import type { Note } from "../src/lib/domain";
const note: Note = {
  id: randomUUID(),
  bookId: null,
  title: "생각",
  content: "본문",
  kind: "thought",
  page: null,
  version: 1,
  createdAt: "2026-10-13T00:00:00Z",
  updatedAt: "2026-10-13T00:00:00Z",
};
it("uses original dates and never mistakes imported timestamps or quotations for my view", () => {
  expect(resolveThoughtRecord(note)).toMatchObject({
    occurredOn: "2026-10-13",
    voice: "self",
    eventVersion: 0,
  });
  const imported = {
    ...note,
    sourceData: {
      app: "iReadItNow HD",
      libraryId: "a",
      recordId: "1",
      raw: { ZTIMESTAMP: null },
    },
  };
  expect(resolveThoughtRecord(imported)).toMatchObject({
    occurredOn: null,
    voice: "unconfirmed",
  });
  expect(
    resolveThoughtRecord({
      ...imported,
      sourceData: { ...imported.sourceData, raw: { ZTIMESTAMP: 86400 } },
    }).occurredOn,
  ).toBe("2001-01-02");
  expect(resolveThoughtRecord({ ...note, kind: "highlight" }).voice).toBe(
    "quote",
  );
  expect(resolveThoughtRecord({ ...note, kind: "claim" }).voice).toBe(
    "unconfirmed",
  );
});
let pg: PGlite,
  db: Database,
  store: ReturnType<typeof createThoughtMapStore>,
  library: ReturnType<typeof createLibraryStore>;
const cmd = (type: string, payload: unknown) => ({
  requestId: randomUUID(),
  type,
  payload,
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
    "017_note_trash",
  ])
    await pg.exec(await readFile(`db/${f}.sql`, "utf8"));
  db = {
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
it("keeps one event across note edits, handles conflicts and isolates owners", async () => {
  const n = await library.mutate(
    "a",
    cmd("addNote", { title: "생각", content: "옛 생각", kind: "thought" }),
  );
  const edit = cmd("setThoughtEvent", {
    noteId: n.id,
    expectedVersion: 0,
    occurredOn: "2020-01-01",
    voice: "self",
  });
  expect(await store.mutate("a", edit)).toEqual(await store.mutate("a", edit));
  await library.mutate(
    "a",
    cmd("editNote", {
      id: n.id,
      expectedVersion: 1,
      title: "생각",
      content: "문장을 다듬음",
      kind: "thought",
    }),
  );
  const state = await store.snapshot("a");
  expect(state.events).toHaveLength(1);
  expect(state.events[0]).toMatchObject({
    noteId: n.id,
    occurredOn: "2020-01-01",
    version: 1,
  });
  await expect(
    store.mutate("b", cmd("setThoughtEvent", { ...(edit.payload as object) })),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    store.mutate("a", cmd("setThoughtEvent", { ...(edit.payload as object) })),
  ).rejects.toMatchObject({ status: 409 });
  expect((await store.snapshot("b")).events).toHaveLength(0);
});
