import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { createAssistStore } from "../src/server/assist-store";
import type { Database, Executor } from "../src/server/library-store";

const measurements: unknown[] = [];
let fixture: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  fixture = await testDatabase();
});
afterAll(async () => {
  await fixture?.pg.close();
  if (process.env.ASSIST_METRICS_FILE)
    writeFileSync(
      process.env.ASSIST_METRICS_FILE,
      JSON.stringify(measurements, null, 2),
    );
});

// All measurements use a fresh in-memory database and synthetic records. The
// optional delay models a fixed round trip; it is not a production benchmark.
function measuredDatabase(db: Database) {
  const queries: string[] = [];
  let queryMs = 0,
    transactionMs = 0,
    transactions = 0;
  const wrap = (tx: Executor): Executor => ({
    query: async (sql, params) => {
      queries.push(sql);
      const started = performance.now();
      try {
        const delay = Number(process.env.ASSIST_LATENCY_MS ?? 0);
        if (delay > 0)
          await new Promise((resolve) => setTimeout(resolve, delay));
        return await tx.query(sql, params);
      } finally {
        queryMs += performance.now() - started;
      }
    },
  });
  return {
    queries,
    db: {
      ...wrap(db),
      transaction: async (fn) => {
        transactions++;
        const started = performance.now();
        try {
          return await db.transaction((tx) => fn(wrap(tx)));
        } finally {
          transactionMs += performance.now() - started;
        }
      },
    } satisfies Database,
    metrics: () => ({
      queries: queries.length,
      transactions,
      queryMs,
      transactionMs,
    }),
  };
}

async function completed(kind: string, noteCount = 2) {
  const owner = randomUUID(),
    id = randomUUID();
  const notes = Array.from({ length: noteCount }, () => randomUUID());
  for (const note of notes)
    await fixture.db.query(
      "INSERT INTO library_notes(id,owner_id,title,content,kind) VALUES($1,$2,'측정 기록','공감과 경계를 함께 살핀다.','thought')",
      [note, owner],
    );
  const connectionId = randomUUID(),
    bundleId = randomUUID();
  if (kind === "connection_title")
    await fixture.db.query(
      "INSERT INTO library_connections(id,owner_id,source_kind,source_id,target_kind,target_id,relation,status,reason,method,title) VALUES($1,$2,'note',$3,'note',$4,'related','accepted','근거','manual','기존 제목')",
      [connectionId, owner, notes[0], notes[1]],
    );
  if (kind === "thought_bundle_title")
    await fixture.db.query(
      "INSERT INTO library_memo_bundles(id,owner_id,title,note_ids) VALUES($1,$2,'기존 제목',$3)",
      [bundleId, owner, JSON.stringify(notes)],
    );
  const store = createAssistStore(fixture.db);
  const preview = await store.preview(owner, {
    purpose: "synthesis",
    useCurrentRelations: true,
    sources: notes.map((note) => ({
      source: { kind: "note", id: note, version: "1" },
    })),
  });
  const sourceIndices = kind.includes("connection")
    ? [0, 1]
    : notes.map((_, i) => i);
  const output = {
    suggestions: [
      {
        kind,
        title: "함께 생각하기",
        reason: "공감과 경계의 관계를 살핀다.",
        sourceIndices,
        topicIds: [],
        outline: [],
        bundleId: kind === "thought_bundle_title" ? bundleId : null,
        evidence: sourceIndices.map((sourceIndex) => ({
          sourceIndex,
          start: 0,
          end: 2,
          quote: "공감",
        })),
      },
    ],
  };
  await fixture.db.query(
    "INSERT INTO library_assist_requests(id,owner_id,request_id,fingerprint,purpose,task,policy_version,status) VALUES($1,$2,$3,'isolated-measurement','synthesis',$4,0,'completed')",
    [id, owner, randomUUID(), JSON.stringify(preview.task)],
  );
  await fixture.db.query(
    "INSERT INTO library_assist_results(id,owner_id,request_id,result) VALUES($1,$2,$3,$4)",
    [randomUUID(), owner, id, JSON.stringify({ valid: true, output })],
  );
  return { owner, id, notes, connectionId, bundleId };
}

it.each(
  [2, 20].flatMap((count) =>
    [
      "note_connection",
      "connection_title",
      "thought_bundle",
      "thought_bundle_title",
    ].map((kind) => ({ kind, count })),
  ),
)(
  "adopts $kind from $count notes without rereading sources or unused target lists",
  async ({ kind, count }) => {
    const s = await completed(kind, count),
      measured = measuredDatabase(fixture.db);
    const store = createAssistStore(measured.db);
    const adopted = await store.adopt(s.owner, s.id, 0);
    const first = measured.metrics();
    const retry = await store.adopt(s.owner, s.id, 0);
    const total = measured.metrics();
    measurements.push({
      kind,
      notes: count,
      first,
      retry: {
        queries: total.queries - first.queries,
        transactionMs: total.transactionMs - first.transactionMs,
      },
    });
    console.info(
      JSON.stringify({
        kind,
        notes: count,
        first,
        retry: {
          queries: total.queries - first.queries,
          queryMs: total.queryMs - first.queryMs,
          transactionMs: total.transactionMs - first.transactionMs,
        },
      }),
    );
    expect(adopted.ok).toBe(true);
    expect(retry).toEqual(adopted);
    expect(first.transactions).toBe(1);
    expect(total.transactions).toBe(2);
    // currentRecord already supplies the locked source content/version used by
    // the task; querying each same source twice adds one round trip per note.
    expect(
      measured.queries.filter((sql) => sql.includes("n.id=$2 AND NOT EXISTS")),
    ).toHaveLength(count * 2);
    // Target lists are deliberately excluded from the source-freshness hash.
    expect(
      measured.queries.some(
        (sql) =>
          sql.includes("ORDER BY id LIMIT 100") ||
          sql.includes("ORDER BY created_at,id LIMIT 40"),
      ),
    ).toBe(false);
    const revisions = (
      await fixture.db.query(
        "SELECT * FROM library_revisions WHERE owner_id=$1",
        [s.owner],
      )
    ).rows;
    expect(revisions).toHaveLength(1);
    expect(
      (
        await fixture.db.query(
          "SELECT adoption FROM library_assist_results WHERE owner_id=$1",
          [s.owner],
        )
      ).rows[0].adoption,
    ).toHaveLength(1);
  },
);

it.each(["note", "event", "target", "trash", "owner"])(
  "still rejects a changed %s before writing",
  async (change) => {
    const s = await completed("connection_title");
    if (change === "note")
      await fixture.db.query(
        "UPDATE library_notes SET version=version+1 WHERE owner_id=$1 AND id=$2",
        [s.owner, s.notes[0]],
      );
    if (change === "event")
      await fixture.db.query(
        "INSERT INTO library_thought_events(id,owner_id,note_id,occurred_on,voice,date_source) VALUES(gen_random_uuid(),$1,$2,'2025-01-01','quote','user')",
        [s.owner, s.notes[0]],
      );
    if (change === "target")
      await fixture.db.query(
        "UPDATE library_connections SET version=version+1 WHERE owner_id=$1 AND id=$2",
        [s.owner, s.connectionId],
      );
    if (change === "trash")
      await fixture.db.query(
        "INSERT INTO library_note_trash(owner_id,id) VALUES($1,$2)",
        [s.owner, s.notes[0]],
      );
    await expect(
      createAssistStore(fixture.db).adopt(
        change === "owner" ? "other-owner" : s.owner,
        s.id,
        0,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (
        await fixture.db.query(
          "SELECT adoption FROM library_assist_results WHERE owner_id=$1",
          [s.owner],
        )
      ).rows[0].adoption,
    ).toHaveLength(0);
    expect(
      (
        await fixture.db.query(
          "SELECT * FROM library_revisions WHERE owner_id=$1",
          [s.owner],
        )
      ).rows,
    ).toHaveLength(0);
  },
);
