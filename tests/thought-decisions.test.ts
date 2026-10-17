import { beforeAll, afterAll, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createLibraryStore, type Database } from "../src/server/library-store";
import {
  createThoughtMapStore,
  currentRecord,
} from "../src/server/thought-map-store";
import type { CandidateInput } from "../src/lib/thought-map/types";
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
    "025_book_exclusions",
    "026_device_sync",
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
async function pair(owner: string): Promise<CandidateInput> {
  const ids: string[] = [];
  for (const [content, date] of [
    ["정서를 억제해야 한다.", "2020-01-01"],
    ["정서를 수용해야 한다.", "2021-01-01"],
  ]) {
    const n = await library.mutate(
      owner,
      cmd("addNote", { title: "생각", content, kind: "thought" }),
    );
    ids.push(n.id!);
    await store.mutate(
      owner,
      cmd("setThoughtEvent", {
        noteId: n.id,
        expectedVersion: 0,
        occurredOn: date,
        voice: "self",
      }),
    );
  }
  const before = await currentRecord(db, owner, ids[0]),
    after = await currentRecord(db, owner, ids[1]);
  const evidence = (n: typeof before) => ({
    noteId: n.id,
    noteVersion: n.version,
    start: 0,
    end: n.content.length,
    quote: n.content,
  });
  return {
    before,
    after,
    comparison: {
      relation: "reverses",
      before: evidence(before),
      after: evidence(after),
      explanation: "정서에 대한 입장 전환",
    },
    topicId: null,
    context: [],
    provenance: {
      modelDigest: "test",
      promptVersion: "1",
      retrievalVersion: "1",
    },
  };
}
it("requires approval, preserves rejection across model updates, and records reopen history", async () => {
  const input = await pair("decisions"),
    saved = await store.saveCandidate("decisions", input);
  let state = await store.snapshot("decisions");
  expect(state.candidates[0].status).toBe("pending");
  await store.mutate(
    "decisions",
    cmd("decideCandidate", {
      id: saved.id,
      expectedVersion: 1,
      decision: "reject",
      relation: "reverses",
      reason: "wrong_relation",
      explanation: "다른 맥락",
    }),
  );
  await store.saveCandidate("decisions", {
    ...input,
    provenance: { ...input.provenance, modelDigest: "new-model" },
  });
  state = await store.snapshot("decisions");
  expect(state.candidates).toHaveLength(1);
  expect(state.candidates[0].status).toBe("rejected");
  await store.mutate(
    "decisions",
    cmd("decideCandidate", {
      id: saved.id,
      expectedVersion: 2,
      decision: "reopen",
      relation: "reverses",
      reason: "other",
      explanation: "다시 검토",
    }),
  );
  state = await store.snapshot("decisions");
  expect(state.feedback).toHaveLength(2);
  expect(state.feedback.find((f) => f.decision === "reopen")?.revokesId).toBe(
    state.feedback.find((f) => f.decision === "reject")?.id,
  );
});
it("rejects stale note or event approval, including personal-to-quotation changes", async () => {
  const input = await pair("race"),
    saved = await store.saveCandidate("race", input);
  await store.mutate(
    "race",
    cmd("setThoughtEvent", {
      noteId: input.before.id,
      expectedVersion: 1,
      occurredOn: "2020-01-01",
      voice: "quote",
    }),
  );
  await expect(
    store.mutate(
      "race",
      cmd("decideCandidate", {
        id: saved.id,
        expectedVersion: 1,
        decision: "accept",
        relation: "reverses",
        reason: "relevant",
        explanation: "확인",
      }),
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect((await store.snapshot("race")).candidates[0].outdated).toBe(true);
  await expect(
    store.mutate(
      "race",
      cmd("connectThoughts", {
        beforeId: input.before.id,
        afterId: input.after.id,
        relation: "reverses",
        explanation: "직접 연결",
      }),
    ),
  ).rejects.toMatchObject({ status: 400 });
  await expect(store.saveCandidate("foreign", input)).rejects.toMatchObject({
    status: 404,
  });
});
it("verifies actual quoted substrings before saving a candidate", async () => {
  const input = await pair("quote");
  await expect(
    store.saveCandidate("quote", {
      ...input,
      comparison: {
        ...input.comparison,
        before: { ...input.comparison.before!, quote: "없는 인용" },
      },
    }),
  ).rejects.toMatchObject({ status: 400 });
  expect((await store.snapshot("quote")).candidates).toHaveLength(0);
});

it("preserves a manually selected passage and common confirmed topic, rejecting stale review versions", async () => {
  const owner = "manual-review",
    input = await pair(owner),
    topicId = randomUUID();
  await db.query(
    "INSERT INTO library_topics(id,owner_id,name) VALUES($1,$2,'정서')",
    [topicId, owner],
  );
  for (const r of [input.before, input.after])
    await db.query(
      "INSERT INTO library_topic_memberships(id,owner_id,topic_id,source_kind,source_id,source_version,status,method) VALUES($1,$2,$3,'note',$4,$5,'accepted','manual')",
      [randomUUID(), owner, topicId, r.id, String(r.version)],
    );
  const reviewedRecords = {
    before: {
      ...input.comparison.before!,
      eventVersion: input.before.eventVersion,
    },
    after: {
      ...input.comparison.after!,
      eventVersion: input.after.eventVersion,
    },
  };
  const payload = {
    beforeId: input.before.id,
    afterId: input.after.id,
    topicId,
    reviewedRecords,
    relation: "revises",
    explanation: "내가 읽고 직접 판단했다.",
  };
  await expect(
    store.mutate(
      owner,
      cmd("connectThoughts", {
        ...payload,
        reviewedRecords: {
          ...reviewedRecords,
          before: { ...reviewedRecords.before, noteVersion: 99 },
        },
      }),
    ),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    store.mutate(
      owner,
      cmd("connectThoughts", {
        ...payload,
        reviewedRecords: {
          ...reviewedRecords,
          before: { ...reviewedRecords.before, eventVersion: 99 },
        },
      }),
    ),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    store.mutate(
      owner,
      cmd("connectThoughts", {
        ...payload,
        reviewedRecords: {
          ...reviewedRecords,
          before: { ...reviewedRecords.before, quote: "원문에 없는 문장" },
        },
      }),
    ),
  ).rejects.toMatchObject({ status: 400 });
  const linked = await store.mutate(owner, cmd("connectThoughts", payload));
  expect(
    (await store.snapshot(owner)).candidates.find((c) => c.id === linked.id),
  ).toMatchObject({
    topicId,
    status: "accepted",
    comparison: {
      before: input.comparison.before,
      after: input.comparison.after,
    },
    provenance: { modelDigest: "manual" },
  });
  await db.query(
    "UPDATE library_topic_memberships SET source_version='99' WHERE source_id=$1",
    [input.before.id],
  );
  await expect(
    store.mutate(owner, cmd("connectThoughts", payload)),
  ).rejects.toMatchObject({ status: 409 });
  await db.query(
    "UPDATE library_topic_memberships SET source_version='1',status='suggested' WHERE source_id=$1",
    [input.before.id],
  );
  await expect(
    store.mutate(owner, cmd("connectThoughts", payload)),
  ).rejects.toMatchObject({ status: 409 });
});
