import { beforeAll, afterAll, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createLibraryStore, type Database } from "../src/server/library-store";
import {
  createThoughtJobStore,
  sourceVersion,
} from "../src/server/thought-job-store";
let pg: PGlite,
  db: Database,
  store: ReturnType<typeof createThoughtJobStore>,
  library: ReturnType<typeof createLibraryStore>;
const cmd = (type: string, payload: unknown) => ({
  requestId: randomUUID(),
  type,
  payload,
});
const config = { modelDigest: "m", promptVersion: "1", retrievalVersion: "1" };
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
    "017_note_trash",
    "025_book_exclusions",
  ])
    await pg.exec(await readFile(`db/${f}.sql`, "utf8"));
  db = {
    query: (s, p = []) => pg.query(s, p),
    transaction: (fn) =>
      pg.transaction((tx) => fn({ query: (s, p = []) => tx.query(s, p) })),
  };
  store = createThoughtJobStore(db, { legacyDiagnostics: true });
  library = createLibraryStore(db);
});
afterAll(async () => {
  await pg?.close();
});
async function enqueue(owner: string) {
  const n = await library.mutate(
    owner,
    cmd("addNote", { title: "생각", content: "내 생각", kind: "thought" }),
  );
  const input = {
    kind: "compare" as const,
    sourceId: n.id!,
    sourceVersion: await sourceVersion(db, owner, n.id!),
    modelDigest: "m",
    promptVersion: "1",
    retrievalVersion: "1",
    priority: 1 as const,
  };
  return { n, input, id: await store.enqueue(db, owner, input) };
}
it("deduplicates work, allows one active owner job and rejects an expired lease", async () => {
  const { input, id } = await enqueue("lease");
  expect(await store.enqueue(db, "lease", input)).toBe(id);
  const now = new Date("2030-01-01"),
    job = await store.claim("lease", "w1", now, config);
  expect(job?.id).toBe(id);
  expect(await store.claim("lease", "w2", now, config)).toBeNull();
  const retry = await store.claim(
    "lease",
    "w2",
    new Date(+now + 121000),
    config,
  );
  expect(retry?.id).toBe(id);
  expect(retry?.leaseToken).not.toBe(job?.leaseToken);
  await expect(
    store.finish(
      "lease",
      id,
      job!.leaseToken!,
      { candidateInputs: [], indexStatus: "ready" },
      new Date(+now + 122000),
    ),
  ).rejects.toMatchObject({ status: 409 });
  const result = { candidateInputs: [], indexStatus: "ready" as const };
  await store.finish(
    "lease",
    id,
    retry!.leaseToken!,
    result,
    new Date(+now + 122000),
  );
  await store.finish(
    "lease",
    id,
    retry!.leaseToken!,
    result,
    new Date(+now + 123000),
  );
  await expect(
    store.finish(
      "lease",
      id,
      retry!.leaseToken!,
      { ...result, indexStatus: "partial" },
      new Date(+now + 123000),
    ),
  ).rejects.toMatchObject({ status: 409 });
});
it("supersedes edited source work and projects offline waiting without preventing a claim", async () => {
  const { n, id } = await enqueue("edited"),
    job = await store.claim("edited", "w", new Date("2030-01-01"), config);
  await library.mutate(
    "edited",
    cmd("editNote", {
      id: n.id,
      expectedVersion: 1,
      title: "생각",
      content: "새 생각",
      kind: "thought",
    }),
  );
  await expect(
    store.finish(
      "edited",
      id,
      job!.leaseToken!,
      { candidateInputs: [], indexStatus: "ready" },
      new Date("2030-01-01T00:00:01Z"),
    ),
  ).rejects.toMatchObject({ status: 409 });
  await enqueue("offline");
  expect((await store.status("offline", new Date("2030-01-01"))).state).toBe(
    "waiting_for_pc",
  );
  expect(
    await store.claim("offline", "w", new Date("2030-01-01"), config),
  ).not.toBeNull();
});
it("does not roll back a saved note when optional enqueue fails and can reconcile later", async () => {
  const failing: Database = {
    ...db,
    transaction: (fn) =>
      db.transaction((tx) =>
        fn({
          query: (s, p = []) =>
            s.includes("INSERT INTO library_thought_jobs")
              ? Promise.reject(Error("temporary queue outage"))
              : tx.query(s, p),
        }),
      ),
  };
  const n = await createLibraryStore(failing).mutate(
    "outage",
    cmd("addNote", { title: "생각", content: "기록은 보존", kind: "thought" }),
  );
  expect((await library.snapshot("outage")).notes[0].id).toBe(n.id);
  await store.reconcile("outage", {
    modelDigest: "m",
    promptVersion: "1",
    retrievalVersion: "1",
  });
  expect((await store.status("outage", new Date())).queued).toBe(1);
});
