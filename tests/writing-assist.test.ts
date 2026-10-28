import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { emptyBoard } from "../src/lib/whiteboard";
import { writingAnalysis } from "../src/lib/writing-assist";
import { addChapter, addChapterMaterial } from "../src/lib/writing-board";
import { testDatabase } from "./helpers/database";
import { createLibraryStore } from "../src/server/library-store";
import { createAssistStore } from "../src/server/assist-store";
import { createDeviceAuth } from "../src/server/thought-device-auth";
import { pricingVersion, prepareAiTask } from "../src/local/ai/openai";
let f: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  f = await testDatabase();
});
afterAll(async () => {
  await f?.pg.close();
});
it("uses pinned current-board notes and actual outside memo candidates", () => {
  const notes = ["공감", "경계", "공감의 확장"].map((title) => ({
    id: randomUUID(),
    title,
    content: title,
    version: 1,
    bookId: null,
    updatedAt: "2026-10-28",
  }));
  const source: any = {
    board: null,
    notes,
    books: [],
    topics: [],
    memberships: [],
    connections: [],
  };
  let board = addChapter(emptyBoard(), randomUUID());
  board = addChapterMaterial(
    board,
    board.writing!.chapters[0].id,
    {
      id: randomUUID(),
      order: 1,
      kind: "note",
      label: "공감",
      noteIds: [notes[0].id],
      groupIds: [],
    },
    source,
  );
  board.filter.q = "경계";
  const analysis = writingAnalysis(
    source,
    board,
    randomUUID(),
    "공감의 이해",
    "materials",
    board.writing!.chapters[0].id,
  );
  expect(analysis.context.visibleNoteIds.sort()).toEqual(
    notes
      .slice(0, 2)
      .map((n) => n.id)
      .sort(),
  );
  expect(analysis.context.candidateNoteIds.sort()).toEqual(
    notes
      .slice(1)
      .map((n) => n.id)
      .sort(),
  );
  expect(analysis.notes).toHaveLength(3);
  const unfiltered = writingAnalysis(
    source,
    addChapter(emptyBoard(), randomUUID()),
    randomUUID(),
    "글감",
    "materials",
    null,
  );
  expect(unfiltered.context.candidateNoteIds).toHaveLength(3);
  expect(unfiltered.notes).toHaveLength(3);
});
it("keeps exact draft context from preview to claimed job without stale hash or paid requests", async () => {
  const owner = randomUUID(),
    library = createLibraryStore(f.db),
    store = createAssistStore(f.db);
  const sources = [];
  for (const title of ["공감", "경계"]) {
    const note = await library.mutate(owner, {
      requestId: randomUUID(),
      type: "addNote",
      payload: { title, content: title + "에 관한 생각", kind: "thought" },
    });
    sources.push({ source: { kind: "note", id: note.id!, version: "1" } });
  }
  await store.configure(owner, {
    expectedPolicyVersion: 0,
    requestsEnabled: true,
    requestLimitUsd: "1",
    runtimeMonthlyLimitUsd: "5",
    developmentLimitUsd: null,
  });
  const writingContext = {
    boardId: randomUUID(),
    title: "공감에 관한 글",
    request: "titles" as const,
    targetChapterId: null,
    chapters: [],
    visibleNoteIds: sources.map((s) => s.source.id),
    candidateNoteIds: [],
  };
  const selection = {
    purpose: "synthesis",
    focus: "writing_idea",
    sources,
    writingContext,
  };
  const preview = await store.preview(owner, selection);
  expect(preview.task.payload).toHaveProperty("writingContext", writingContext);
  expect(prepareAiTask(preview.task).input[0].content).toContain(
    "request=titles",
  );
  await store.request(owner, {
    ...selection,
    requestId: randomUUID(),
    expectedPolicyVersion: preview.policy.version,
    scopeHash: preview.scopeHash,
  });
  const device = await createDeviceAuth(f.db).issue(owner, "PC"),
    d = { ownerId: owner, deviceId: device.id };
  await store.heartbeat(d, { keyReady: true, priceVersion: pricingVersion });
  const job = await store.claim(d);
  expect(job).toBeTruthy();
  const sending = await store.begin(d, job!.id, job!.leaseToken);
  expect(sending.task.payload).toHaveProperty("writingContext", writingContext);
});
