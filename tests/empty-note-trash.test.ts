import { beforeAll, afterAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { testDatabase } from "./helpers/database";
import { createLibraryStore } from "../src/server/library-store";
let f: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  f = await testDatabase();
});
afterAll(async () => {
  await f?.pg.close();
});
it("permanently empties only the reviewed trash, keeps active/other-owner records and retries idempotently", async () => {
  const store = createLibraryStore(f.db),
    owner = "purge-owner";
  const command = (type: string, payload: unknown) => ({
    type,
    payload,
    requestId: randomUUID(),
  });
  const n = await store.mutate(
    owner,
    command("addNote", { title: "삭제할 기록", content: "삭제 원문" }),
  );
  const active = await store.mutate(
    owner,
    command("addNote", { title: "유지할 기록", content: "유지 원문" }),
  );
  const other = await store.mutate(
    "other-owner",
    command("addNote", { title: "다른 계정", content: "다른 원문" }),
  );
  await store.mutate(
    owner,
    command("deleteNote", { id: n.id, expectedVersion: 1 }),
  );
  await store.mutate(
    "other-owner",
    command("deleteNote", { id: other.id, expectedVersion: 1 }),
  );
  const purge = command("emptyNoteTrash", {
    notes: [{ id: n.id, expectedVersion: 2 }],
  });
  const result = await store.mutate(owner, purge);
  expect(await store.mutate(owner, purge)).toEqual(result);
  expect((await store.snapshot(owner)).deletedNotes).toEqual([]);
  expect((await store.snapshot(owner)).notes.map((x) => x.id)).toEqual([
    active.id,
  ]);
  expect(
    (await f.db.query("SELECT id FROM library_notes WHERE id=$1", [n.id])).rows,
  ).toEqual([]);
  expect(await store.revisions(owner, n.id)).toEqual([]);
  expect(
    (await store.snapshot("other-owner")).deletedNotes?.map((x) => x.id),
  ).toEqual([other.id]);
  await expect(
    store.mutate(
      owner,
      command("emptyNoteTrash", {
        notes: [{ id: active.id, expectedVersion: 1 }],
      }),
    ),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    store.mutate(
      owner,
      command("emptyNoteTrash", {
        notes: [{ id: other.id, expectedVersion: 2 }],
      }),
    ),
  ).rejects.toMatchObject({ status: 409 });
});
it("refuses a restored or edited record and exposes only the narrow purge function to the web role", async () => {
  const store = createLibraryStore(f.db),
    owner = "purge-race";
  const command = (type: string, payload: unknown) => ({
    type,
    payload,
    requestId: randomUUID(),
  });
  const n = await store.mutate(
    owner,
    command("addNote", { title: "복원 기록", content: "보존" }),
  );
  await store.mutate(
    owner,
    command("deleteNote", { id: n.id, expectedVersion: 1 }),
  );
  await store.mutate(
    owner,
    command("restoreNote", { id: n.id, expectedVersion: 2 }),
  );
  await expect(
    store.mutate(
      owner,
      command("emptyNoteTrash", { notes: [{ id: n.id, expectedVersion: 2 }] }),
    ),
  ).rejects.toMatchObject({ status: 409 });
  await f.pg.exec(
    await readFile("db/operations/provision-web-runtime.sql", "utf8"),
  );
  await f.pg.exec("SET SESSION AUTHORIZATION library_web_runtime");
  try {
    await expect(f.pg.exec("DELETE FROM library_notes")).rejects.toThrow();
    const trashed = await store.mutate(
      owner,
      command("deleteNote", { id: n.id, expectedVersion: 3 }),
    );
    await store.mutate(
      owner,
      command("emptyNoteTrash", {
        notes: [{ id: n.id, expectedVersion: trashed.version }],
      }),
    );
    expect((await store.snapshot(owner)).deletedNotes).toEqual([]);
  } finally {
    await f.pg.exec("RESET SESSION AUTHORIZATION");
  }
});
it("removes linked research snapshots and thought evidence but keeps unrelated notes and topics", async () => {
  const store = createLibraryStore(f.db),
    owner = "purge-links";
  const command = (type: string, payload: unknown) => ({
    type,
    payload,
    requestId: randomUUID(),
  });
  const n = await store.mutate(
    owner,
    command("addNote", { title: "삭제할 생각", content: "삭제할 생각 원문" }),
  );
  const kept = await store.mutate(
    owner,
    command("addNote", { title: "남길 생각", content: "남길 생각 원문" }),
  );
  const kept2 = await store.mutate(
    owner,
    command("addNote", { title: "또 남길 생각", content: "다른 원문" }),
  );
  const research = randomUUID(),
    item = randomUUID(),
    candidate = randomUUID(),
    feedback = randomUUID();
  const topics = [randomUUID(), randomUUID()].sort(),
    link = randomUUID(),
    connection = randomUUID(),
    membership = randomUUID();
  await f.db.query(
    "INSERT INTO library_research(id,owner_id,title,kind) VALUES($1,$2,'연구','thesis')",
    [research, owner],
  );
  await f.db.query(
    "INSERT INTO library_research_items(id,owner_id,research_id,note_id,snapshot) VALUES($1,$2,$3,$4,$5)",
    [
      item,
      owner,
      research,
      n.id,
      JSON.stringify({ content: "삭제할 생각 원문" }),
    ],
  );
  await f.db.query(
    "INSERT INTO library_research_placements(id,owner_id,role,position,state) VALUES($1,$2,'evidence',1,'active')",
    [item, owner],
  );
  for (const topic of topics)
    await f.db.query(
      "INSERT INTO library_topics(id,owner_id,name) VALUES($1,$2,'주제')",
      [topic, owner],
    );
  await f.db.query(
    "INSERT INTO library_topic_memberships(id,owner_id,topic_id,source_kind,source_id,source_version,status,method) VALUES($1,$2,$3,'note',$4,'1','accepted','manual')",
    [membership, owner, topics[0], n.id],
  );
  await f.db.query(
    "INSERT INTO library_topic_links(id,owner_id,source_topic_id,target_topic_id,status,supporting_pairs) VALUES($1,$2,$3,$4,'accepted',$5)",
    [
      link,
      owner,
      ...topics,
      JSON.stringify([{ beforeId: n.id, afterId: kept.id }]),
    ],
  );
  await f.db.query(
    "INSERT INTO library_connections(id,owner_id,source_kind,source_id,target_kind,target_id,relation,status) VALUES($1,$2,'note',$3,'note',$4,'related','accepted')",
    [connection, owner, n.id, kept.id],
  );
  await f.db.query(
    "INSERT INTO library_thought_events(id,owner_id,note_id,date_source,voice) VALUES($1,$2,$3,'native','self')",
    [randomUUID(), owner, n.id],
  );
  await f.db.query(
    "INSERT INTO library_evolution_candidates(id,owner_id,before_id,after_id,before_record,after_record,comparison,provenance,pair_key) VALUES($1,$2,$3,$4,'{}','{}','{}','{}','pair')",
    [candidate, owner, n.id, kept.id],
  );
  await f.db.query(
    "INSERT INTO library_analysis_feedback(id,owner_id,candidate_id,original_output,reason,decision) VALUES($1,$2,$3,'{}','확인','accept')",
    [feedback, owner, candidate],
  );
  await f.db.query(
    "INSERT INTO library_analysis_feedback(id,owner_id,candidate_id,original_output,reason,decision,revokes_id) VALUES($1,$2,$3,'{}','재검토','reopen',$4)",
    [randomUUID(), owner, candidate, feedback],
  );
  const contextCandidate = randomUUID();
  await f.db.query(
    "INSERT INTO library_evolution_candidates(id,owner_id,before_id,after_id,before_record,after_record,comparison,provenance,pair_key,context) VALUES($1,$2,$3,$4,'{}','{}','{}','{}','context-pair',$5)",
    [
      contextCandidate,
      owner,
      kept.id,
      kept2.id,
      JSON.stringify([
        {
          source: { kind: "note", id: n.id, version: "1" },
          text: "삭제할 생각 원문",
        },
      ]),
    ],
  );
  await f.db.query(
    "INSERT INTO library_revisions(id,owner_id,entity_id,action,after_data) VALUES($1,$2,$3,'test',$4)",
    [
      randomUUID(),
      owner,
      contextCandidate,
      JSON.stringify({ context: [{ text: "삭제할 생각 원문" }] }),
    ],
  );
  const historyCandidate = randomUUID();
  await f.db.query(
    "INSERT INTO library_evolution_candidates(id,owner_id,before_id,after_id,before_record,after_record,comparison,provenance,pair_key) VALUES($1,$2,$3,$4,'{}','{}','{}','{}','history-pair')",
    [historyCandidate, owner, kept2.id, kept.id],
  );
  await f.db.query(
    "INSERT INTO library_revisions(id,owner_id,entity_id,action,before_data,after_data) VALUES($1,$2,$3,'refreshThoughtCandidate',$4,'{}')",
    [
      randomUUID(),
      owner,
      historyCandidate,
      JSON.stringify({
        context: [
          {
            source: { kind: "note", id: n.id, version: "1" },
            text: "삭제할 생각 원문",
          },
        ],
      }),
    ],
  );
  await f.db.query(
    "INSERT INTO library_revisions(id,owner_id,entity_id,action,after_data) VALUES($1,$2,$3,'test',$4)",
    [
      randomUUID(),
      owner,
      item,
      JSON.stringify({ content: "삭제할 생각 원문" }),
    ],
  );
  await store.mutate(
    owner,
    command("deleteNote", { id: n.id, expectedVersion: 1 }),
  );
  await store.mutate(
    owner,
    command("emptyNoteTrash", { notes: [{ id: n.id, expectedVersion: 2 }] }),
  );
  for (const table of [
    "library_research_items",
    "library_research_placements",
    "library_evolution_candidates",
    "library_analysis_feedback",
    "library_connections",
    "library_topic_memberships",
    "library_thought_events",
  ]) {
    expect(
      (await f.db.query(`SELECT id FROM ${table} WHERE owner_id=$1`, [owner]))
        .rows,
    ).toEqual([]);
  }
  expect(
    (
      await f.db.query(
        "SELECT supporting_pairs,status FROM library_topic_links WHERE id=$1",
        [link],
      )
    ).rows,
  ).toEqual([{ supporting_pairs: [], status: "suggested" }]);
  expect(
    (
      await f.db.query("SELECT id FROM library_topics WHERE owner_id=$1", [
        owner,
      ])
    ).rows,
  ).toHaveLength(2);
  expect(
    (
      await f.db.query("SELECT id FROM library_research WHERE id=$1", [
        research,
      ])
    ).rows,
  ).toHaveLength(1);
  expect(await store.revisions(owner, item)).toEqual([]);
  expect(await store.revisions(owner, contextCandidate)).toEqual([]);
  expect(await store.revisions(owner, historyCandidate)).toEqual([]);
  expect((await store.snapshot(owner)).notes.map((n) => n.id).sort()).toEqual(
    [kept.id, kept2.id].sort(),
  );
});
it("blocks in-flight AI requests atomically, then removes completed results without erasing the cost ledger", async () => {
  const store = createLibraryStore(f.db),
    owner = "purge-assist";
  const command = (type: string, payload: unknown) => ({
    type,
    payload,
    requestId: randomUUID(),
  });
  const n = await store.mutate(
    owner,
    command("addNote", { title: "AI 자료", content: "나의 기록" }),
  );
  const usage = randomUUID(),
    request = randomUUID();
  await f.db.query(
    "INSERT INTO library_ai_usage(id,owner_id,operation_id,phase,period,max_cost_usd,policy_version,status) VALUES($1,$2,$3,'runtime','2026-10',0.01,1,'sending')",
    [usage, owner, randomUUID()],
  );
  await f.db.query(
    "INSERT INTO library_assist_requests(id,owner_id,request_id,fingerprint,purpose,task,policy_version,status,reservation_id) VALUES($1,$2,$3,'test','tag_suggestion',$4,1,'sending',$5)",
    [
      request,
      owner,
      randomUUID(),
      JSON.stringify({
        payload: {
          sources: [{ source: { kind: "note", id: n.id }, text: "나의 기록" }],
        },
      }),
      usage,
    ],
  );
  await store.mutate(
    owner,
    command("deleteNote", { id: n.id, expectedVersion: 1 }),
  );
  const purge = command("emptyNoteTrash", {
    notes: [{ id: n.id, expectedVersion: 2 }],
  });
  await expect(store.mutate(owner, purge)).rejects.toMatchObject({
    status: 409,
  });
  expect((await store.snapshot(owner)).deletedNotes).toHaveLength(1);
  await f.db.query(
    "UPDATE library_assist_requests SET status='completed' WHERE id=$1",
    [request],
  );
  await f.db.query(
    "UPDATE library_ai_usage SET status='settled',cost_usd=0.001 WHERE id=$1",
    [usage],
  );
  await f.db.query(
    "INSERT INTO library_assist_results(id,owner_id,request_id,result) VALUES($1,$2,$3,$4)",
    [randomUUID(), owner, request, JSON.stringify({ quote: "나의 기록" })],
  );
  await store.mutate(owner, purge);
  expect(
    (
      await f.db.query("SELECT id FROM library_assist_requests WHERE id=$1", [
        request,
      ])
    ).rows,
  ).toEqual([]);
  expect(
    (
      await f.db.query(
        "SELECT id FROM library_assist_results WHERE request_id=$1",
        [request],
      )
    ).rows,
  ).toEqual([]);
  expect(
    (
      await f.db.query(
        "SELECT status,cost_usd FROM library_ai_usage WHERE id=$1",
        [usage],
      )
    ).rows,
  ).toEqual([{ status: "settled", cost_usd: "0.001000000" }]);
});
