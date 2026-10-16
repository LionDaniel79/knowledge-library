import { PGlite } from "@electric-sql/pglite";
import { beforeAll, afterAll, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createLibraryStore, type Database } from "../src/server/library-store";
import { createKnowledgeStore } from "../src/server/knowledge-store";
import { readBibliography } from "../src/server/bibliography";
let pg: PGlite,
  db: Database,
  store: ReturnType<typeof createKnowledgeStore>,
  library: ReturnType<typeof createLibraryStore>;
const cmd = (type: string, payload: unknown) => ({
  requestId: randomUUID(),
  type,
  payload,
});
beforeAll(async () => {
  pg = new PGlite();
  for (const file of [
    "001_library",
    "002_ireaditnow",
    "003_reading_history",
    "004_pdf_library",
    "005_knowledge",
    "006_catalog",
    "007_thought_map",
    "008_thought_jobs",
    "013_pdf_processing_scope",
    "016_research_organization",
    "017_note_trash",
  ])
    await pg.exec(await readFile(`db/${file}.sql`, "utf8"));
  db = {
    query: (s, p = []) => pg.query(s, p),
    transaction: (fn) =>
      pg.transaction((tx) => fn({ query: (s, p = []) => tx.query(s, p) })),
  };
  store = createKnowledgeStore(db);
  library = createLibraryStore(db);
});
afterAll(async () => {
  await pg?.close();
});
it("links explicit Zotero identifiers without modifying books and guards owner, revision and duplicate mappings", async () => {
  const book = await library.mutate(
    "zotero",
    cmd("addBook", {
      title: "서지",
      author: "저자",
      publisher: "출판사",
      formats: ["paper"],
    }),
  );
  const other = await library.mutate(
    "zotero",
    cmd("addBook", { title: "다른 책", formats: ["paper"] }),
  );
  const payload = {
    bookId: book.id,
    expectedBookVersion: 1,
    url: "https://www.zotero.org/users/123/items/ABCD1234",
    expectedVersion: 0,
    state: "active",
  };
  const request = cmd("linkZotero", payload);
  expect(await store.mutate("zotero", request)).toEqual(
    await store.mutate("zotero", request),
  );
  await expect(
    store.mutate("foreign", cmd("linkZotero", payload)),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    store.mutate("zotero", cmd("linkZotero", { ...payload, bookId: other.id })),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    store.mutate("zotero", cmd("linkZotero", payload)),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    store.mutate(
      "zotero",
      cmd("linkZotero", { ...payload, url: payload.url + "?key=secret" }),
    ),
  ).rejects.toMatchObject({ status: 400 });
  await store.mutate(
    "zotero",
    cmd("linkZotero", { ...payload, expectedVersion: 1, state: "removed" }),
  );
  expect(
    (await db.query("SELECT version FROM library_books WHERE id=$1", [book.id]))
      .rows[0].version,
  ).toBe(1);
  expect(
    (await readBibliography(db, "zotero", { bookId: book.id }))[0].title,
  ).toBe("서지");
  await expect(
    readBibliography(db, "foreign", { bookId: book.id }),
  ).rejects.toMatchObject({ status: 404 });
});
it("exports research bibliography from frozen sources and excludes removed materials", async () => {
  const book = await library.mutate(
    "export",
    cmd("addBook", {
      title: "담을 당시 책",
      author: "당시 저자",
      formats: ["paper"],
    }),
  );
  const note = await library.mutate(
    "export",
    cmd("addNote", { bookId: book.id, title: "메모", content: "비공개 생각" }),
  );
  const research = await store.mutate(
    "export",
    cmd("createResearch", { title: "연구", kind: "sermon", question: "" }),
  );
  const item = await store.mutate(
    "export",
    cmd("addResearchNote", { researchId: research.id, noteId: note.id }),
  );
  await db.query(
    "UPDATE library_books SET title='현재 책',version=version+1 WHERE id=$1",
    [book.id],
  );
  const output = await readBibliography(db, "export", {
    researchId: research.id,
  });
  expect(output[0].title).toBe("담을 당시 책");
  expect(JSON.stringify(output)).not.toContain("비공개 생각");
  await store.mutate(
    "export",
    cmd("placeResearchItem", {
      itemId: item.id,
      expectedVersion: 0,
      role: "background",
      section: "",
      position: 1,
      comment: "",
      state: "removed",
    }),
  );
  expect(
    await readBibliography(db, "export", { researchId: research.id }),
  ).toEqual([]);
  await expect(
    readBibliography(db, "foreign", { researchId: research.id }),
  ).rejects.toMatchObject({ status: 404 });
});
it("keeps human research placement versioned, reversible, isolated and separate from source snapshots", async () => {
  const note = await library.mutate(
    "board",
    cmd("addNote", { title: "근거", content: "원문", kind: "evidence" }),
  );
  const research = await store.mutate(
    "board",
    cmd("createResearch", { title: "연구", kind: "thesis", question: "왜?" }),
  );
  const item = await store.mutate(
    "board",
    cmd("addResearchNote", { researchId: research.id, noteId: note.id }),
  );
  const payload = {
    itemId: item.id,
    expectedVersion: 0,
    role: "counterargument",
    section: "반론 검토",
    position: 2,
    comment: "내가 판단한 반론",
    state: "active",
  };
  const request = cmd("placeResearchItem", payload);
  expect(await store.mutate("board", request)).toEqual(
    await store.mutate("board", request),
  );
  await expect(
    store.mutate("other", cmd("placeResearchItem", payload)),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    store.mutate("board", cmd("placeResearchItem", payload)),
  ).rejects.toMatchObject({ status: 409 });
  await store.mutate(
    "board",
    cmd("placeResearchItem", {
      ...payload,
      expectedVersion: 1,
      state: "removed",
    }),
  );
  await store.mutate(
    "board",
    cmd("placeResearchItem", { ...payload, expectedVersion: 2 }),
  );
  const state = await store.snapshot("board");
  expect(state.placements[0]).toMatchObject({
    role: "counterargument",
    state: "active",
    version: 3,
  });
  expect(state.items[0].snapshot.note.content).toBe("원문");
  expect(await library.revisions("board", item.id!)).toHaveLength(3);
});
it("uses personal note tags for suggestions without approving connections or modifying notes", async () => {
  const owner = "tag-connections",
    tags = ["공감", "관계"];
  const a = await library.mutate(
    owner,
    cmd("addNote", { title: "감정", content: "이해", tags }),
  );
  const b = await library.mutate(
    owner,
    cmd("addNote", { title: "경험", content: "성찰", tags }),
  );
  await library.mutate(
    "tag-foreign",
    cmd("addNote", { title: "외부", content: "별개", tags }),
  );
  const before = await library.snapshot(owner);
  await store.mutate(owner, cmd("suggest", { kind: "note", id: a.id }));
  const state = await store.snapshot(owner);
  expect(state.connections).toHaveLength(1);
  expect(state.connections[0]).toMatchObject({
    source_id: a.id,
    target_id: b.id,
    status: "suggested",
    reason: "공통 표현: 공감, 관계",
  });
  expect(await library.snapshot(owner)).toEqual(before);
});
it("preserves rejected suggestions, revisions, optimistic edits and owner boundaries", async () => {
  const a = await library.mutate(
    "a",
    cmd("addNote", { title: "정서와 상담", content: "정서 상담 관계" }),
  );
  const b = await library.mutate(
    "a",
    cmd("addNote", { title: "상담 관계", content: "정서 상담 관계" }),
  );
  const foreign = await library.mutate(
    "b",
    cmd("addNote", { title: "정서 상담", content: "정서 상담 관계" }),
  );
  await expect(
    store.mutate(
      "a",
      cmd("connect", {
        sourceKind: "note",
        sourceId: a.id,
        targetKind: "note",
        targetId: foreign.id,
        relation: "related",
        reason: "관계",
      }),
    ),
  ).rejects.toMatchObject({ status: 404 });
  await store.mutate("a", cmd("suggest", { kind: "note", id: a.id }));
  let state = await store.snapshot("a");
  expect(state.connections).toHaveLength(1);
  const link = state.connections[0];
  const reject = cmd("editConnection", {
    id: link.id,
    expectedVersion: 1,
    status: "rejected",
    relation: "related",
    reason: "맥락이 다름",
  });
  expect(await store.mutate("a", reject)).toEqual(
    await store.mutate("a", reject),
  );
  await expect(
    store.mutate(
      "a",
      cmd("editConnection", { ...(reject.payload as object), reason: "다름" }),
    ),
  ).rejects.toMatchObject({ status: 409 });
  await store.mutate("a", cmd("suggest", { kind: "note", id: a.id }));
  state = await store.snapshot("a");
  expect(state.connections[0].status).toBe("rejected");
  expect(await library.revisions("a", link.id)).toHaveLength(2);
  expect((await store.snapshot("b")).connections).toHaveLength(0);
  expect(state.connections[0].target_id).toBe(b.id);
});
it("freezes cited research material and deduplicates additions", async () => {
  const note = await library.mutate(
    "research",
    cmd("addNote", { title: "근거", content: "원래 생각", kind: "evidence" }),
  );
  const research = await store.mutate(
    "research",
    cmd("createResearch", {
      title: "돌봄",
      kind: "sermon",
      question: "돌봄이란?",
    }),
  );
  const add = cmd("addResearchNote", {
    researchId: research.id,
    noteId: note.id,
  });
  await store.mutate("research", add);
  await store.mutate(
    "research",
    cmd("addResearchNote", { researchId: research.id, noteId: note.id }),
  );
  await library.mutate(
    "research",
    cmd("editNote", {
      id: note.id,
      expectedVersion: 1,
      title: "근거",
      content: "바뀐 생각",
      kind: "evidence",
    }),
  );
  const state = await store.snapshot("research");
  expect(state.items).toHaveLength(1);
  expect(state.items[0].snapshot.note.content).toBe("원래 생각");
  await expect(
    store.mutate(
      "other",
      cmd("addResearchNote", { researchId: research.id, noteId: note.id }),
    ),
  ).rejects.toMatchObject({ status: 404 });
});
