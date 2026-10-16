import { beforeAll, afterAll, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createLibraryStore, type Database } from "../src/server/library-store";
import {
  createThoughtJobStore,
  sourceVersion,
} from "../src/server/thought-job-store";
import { createThoughtMapStore } from "../src/server/thought-map-store";
let pg: PGlite, db: Database;
const cmd = (type: string, payload: unknown) => ({
  requestId: randomUUID(),
  type,
  payload,
});
beforeAll(async () => {
  pg = new PGlite();
  for (const f of (await readdir("db"))
    .filter((f) => /^\d+.*\.sql$/.test(f))
    .sort())
    await pg.exec(await readFile(`db/${f}`, "utf8"));
  db = {
    query: (s, p = []) => pg.query(s, p),
    transaction: (fn) =>
      pg.transaction((tx) => fn({ query: (s, p = []) => tx.query(s, p) })),
  };
});
afterAll(async () => pg?.close());
it("saving, editing and dating notes never queues generation", async () => {
  const library = createLibraryStore(db),
    owner = "manual";
  const n = await library.mutate(
    owner,
    cmd("addNote", { title: "생각", content: "내 글", kind: "thought" }),
  );
  await library.mutate(
    owner,
    cmd("editNote", {
      id: n.id,
      expectedVersion: 1,
      title: "생각",
      content: "수정한 내 글",
      kind: "thought",
    }),
  );
  await createThoughtMapStore(db).mutate(
    owner,
    cmd("setThoughtEvent", {
      noteId: n.id,
      expectedVersion: 0,
      occurredOn: "2026-10-13",
      voice: "self",
    }),
  );
  await library.snapshot(owner);
  const jobs = createThoughtJobStore(db);
  await jobs.heartbeat(owner, "pc", 30);
  await jobs.reconcile(owner);
  expect(
    (
      await db.query("SELECT id FROM library_thought_jobs WHERE owner_id=$1", [
        owner,
      ])
    ).rows,
  ).toHaveLength(0);
  expect((await library.snapshot(owner)).notes[0].content).toBe("수정한 내 글");
});
it("old queued work cannot be claimed and a running result cannot be committed", async () => {
  const owner = "old",
    library = createLibraryStore(db),
    jobs = createThoughtJobStore(db);
  const n = await library.mutate(
    owner,
    cmd("addNote", { title: "이전 기록", content: "보존", kind: "thought" }),
  );
  const id = randomUUID(),
    token = randomUUID();
  await db.query(
    "INSERT INTO library_thought_jobs(id,owner_id,kind,source_id,source_version,source_hash,model_digest,prompt_version,retrieval_version,priority,fingerprint,status,lease_token,lease_expires_at) VALUES($1,$2,'compare',$3,$4,'h','unconfigured','compare-v3-defined-relations','three-route-v1',0,$6,'running',$5,now()+interval '5 minutes')",
    [id, owner, n.id, await sourceVersion(db, owner, n.id!), token, "old-job"],
  );
  await expect(
    jobs.finish(owner, id, token, {
      candidateInputs: [],
      indexStatus: "ready",
    }),
  ).rejects.toMatchObject({ status: 410 });
  await db.query(
    "UPDATE library_thought_jobs SET status='queued' WHERE id=$1",
    [id],
  );
  expect(await jobs.claim(owner, "pc")).toBeNull();
  expect(
    (
      await db.query(
        "SELECT id FROM library_evolution_candidates WHERE owner_id=$1",
        [owner],
      )
    ).rows,
  ).toHaveLength(0);
});
