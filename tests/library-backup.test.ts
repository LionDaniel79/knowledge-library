import { beforeAll, afterAll, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { createLibraryStore } from "../src/server/library-store";
import { createKnowledgeStore } from "../src/server/knowledge-store";
import { createThoughtMapStore } from "../src/server/thought-map-store";
import { createBookRelationStore } from "../src/server/book-relations";
import {
  noteFromRow,
  resolveThoughtRecord,
} from "../src/lib/thought-map/records";
import {
  createLibraryBackup,
  inspectLibraryBackup,
  restoreLibraryBackup,
} from "../src/server/library-backup";
let source: Awaited<ReturnType<typeof testDatabase>>, target: typeof source;
let backup: any, book: string, note: string;
function canonical(v: any): any {
  return Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical(v[k])]),
        )
      : v;
}
function seal(v: any) {
  const { sha256: _, ...payload } = v;
  v.sha256 = createHash("sha256")
    .update(JSON.stringify(canonical(payload)))
    .digest("hex");
  return v;
}
it("round trips edition relationships and keeps older backups compatible", async () => {
  const origin = await testDatabase(),
    dest = await testDatabase();
  try {
    const l = createLibraryStore(origin.db),
      ids = [];
    for (let i = 0; i < 2; i++)
      ids.push(
        (
          await l.mutate("books", {
            requestId: randomUUID(),
            type: "addBook",
            payload: { title: `판본${i}`, formats: ["paper"] },
          })
        ).id!,
      );
    await createBookRelationStore(origin.db).mutate("books", {
      requestId: randomUUID(),
      leftId: ids[0],
      rightId: ids[1],
      leftVersion: 1,
      rightVersion: 1,
      relation: "different_edition",
      state: "accepted",
      reason: "번역자가 다름",
      expectedVersion: 0,
    });
    const knowledge = createKnowledgeStore(origin.db),
      command = (type: string, payload: unknown) => ({
        requestId: randomUUID(),
        type,
        payload,
      });
    const note = await l.mutate(
      "books",
      command("addNote", { title: "근거", content: "원래 글", bookId: ids[0] }),
    );
    const research = await knowledge.mutate(
      "books",
      command("createResearch", {
        title: "연구",
        kind: "thesis",
        question: "질문",
      }),
    );
    const item = await knowledge.mutate(
      "books",
      command("addResearchNote", { researchId: research.id, noteId: note.id }),
    );
    await knowledge.mutate(
      "books",
      command("placeResearchItem", {
        itemId: item.id,
        expectedVersion: 0,
        role: "evidence",
        section: "1장",
        position: 1,
        comment: "나의 해석",
        state: "active",
      }),
    );
    await knowledge.mutate(
      "books",
      command("linkZotero", {
        bookId: ids[0],
        expectedBookVersion: 1,
        url: "https://www.zotero.org/users/123/items/ABCD1234",
        expectedVersion: 0,
        state: "active",
      }),
    );
    const saved = await createLibraryBackup(origin.db, "books");
    expect(saved.tables.library_research_placements).toHaveLength(1);
    expect(saved.tables.library_external_links).toHaveLength(1);
    const unsafe = structuredClone(saved);
    unsafe.tables.library_external_links[0].url = "javascript:alert(1)";
    seal(unsafe);
    await expect(
      inspectLibraryBackup(dest.db, "copy", unsafe),
    ).rejects.toMatchObject({ status: 400 });
    expect(saved.tables.library_book_relations).toHaveLength(1);
    await restoreLibraryBackup(dest.db, "copy", saved);
    expect((await createLibraryBackup(dest.db, "copy")).tables).toEqual(
      saved.tables,
    );
    const older: any = structuredClone(saved);
    delete older.tables.library_book_relations;
    delete older.tables.library_research_placements;
    delete older.tables.library_external_links;
    const rows = (
      await origin.db.query(
        "SELECT table_name,column_name,udt_name,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1::text[]) ORDER BY table_name,ordinal_position",
        [Object.keys(older.tables)],
      )
    ).rows;
    older.schema = createHash("sha256")
      .update(JSON.stringify(canonical(rows)))
      .digest("hex");
    seal(older);
    expect(
      (await inspectLibraryBackup(dest.db, "legacy-empty", older)).canRestore,
    ).toBe(true);
    const legacy = await testDatabase();
    try {
      await restoreLibraryBackup(legacy.db, "legacy-empty", older);
      expect(
        (await createLibraryBackup(legacy.db, "legacy-empty")).tables
          .library_book_relations,
      ).toEqual([]);
    } finally {
      await legacy.pg.close();
    }
  } finally {
    await origin.pg.close();
    await dest.pg.close();
  }
});
beforeAll(async () => {
  source = await testDatabase();
  target = await testDatabase();
  await source.pg.exec("SET TIME ZONE 'Asia/Seoul'");
  await target.pg.exec("SET TIME ZONE 'UTC'");
  const store = createLibraryStore(source.db);
  book = (
    await store.mutate("original", {
      requestId: randomUUID(),
      type: "addBook",
      payload: {
        title: "기억할 책",
        formats: ["paper", "pdf"],
        tags: ["정서"],
      },
    })
  ).id;
  note = (
    await store.mutate("original", {
      requestId: randomUUID(),
      type: "addNote",
      payload: {
        bookId: book,
        title: "나의 기록",
        content: "내 생각 그대로",
        kind: "highlight",
        page: 13,
        tags: ["질문"],
      },
    })
  ).id;
  await store.mutate("original", {
    requestId: randomUUID(),
    type: "startReading",
    payload: { bookId: book, startedOn: "2026-01-01" },
  });
  await source.db.query(
    "UPDATE library_books SET source_key='legacy:1',source_data=$1 WHERE id=$2",
    [
      JSON.stringify({ app: "iReadItNow", raw: { originalText: "보존" } }),
      book,
    ],
  );
  const research = randomUUID(),
    parent = randomUUID(),
    child = randomUUID(),
    run = randomUUID(),
    ref = randomUUID();
  await source.db.query(
    "INSERT INTO library_research(id,owner_id,title,kind) VALUES($1,'original','연구','thesis')",
    [research],
  );
  await createKnowledgeStore(source.db).mutate("original", {
    requestId: randomUUID(),
    type: "addResearchNote",
    payload: { researchId: research, noteId: note },
  });
  await source.db.query(
    "INSERT INTO library_topics(id,owner_id,name) VALUES($1,'original','상담')",
    [parent],
  );
  await source.db.query(
    "INSERT INTO library_topics(id,owner_id,name,parent_id) VALUES($1,'original','정서',$2)",
    [child, parent],
  );
  await source.db.query(
    "INSERT INTO library_topic_memberships(id,owner_id,topic_id,source_kind,source_id,source_version,status,method) VALUES($1,'original',$2,'note',$3,'1','accepted','manual')",
    [randomUUID(), child, note],
  );
  await source.db.query(
    "INSERT INTO library_connections(id,owner_id,source_kind,source_id,target_kind,target_id,relation,status,reason) VALUES($1,'original','book',$2,'note',$3,'supports','accepted','직접 연결')",
    [randomUUID(), book, note],
  );
  await source.db.query(
    "INSERT INTO library_curation_runs(id,owner_id,scope_hash,executor) VALUES($1,'original','scope','codex')",
    [run],
  );
  await source.db.query(
    "INSERT INTO library_reference_sources(id,owner_id,source_kind,source_id,source_version,url,provider,title,content_hash,excerpt,edition_match) VALUES($1,'original','book',$2,'1','https://example.org','제공처','출처','hash','내용','isbn')",
    [ref, book],
  );
  await source.db.query(
    "INSERT INTO library_curation_items(id,owner_id,run_id,source_kind,source_id,source_version,kind,value,evidence,coverage,origin,generator,fingerprint) VALUES($1,'original',$2,'book',$3,'1','tag','\"상담\"',$4,'metadata','codex','dev','unique')",
    [
      randomUUID(),
      run,
      book,
      JSON.stringify({ quote: "내용", referenceId: ref }),
    ],
  );
  const after = (
    await store.mutate("original", {
      requestId: randomUUID(),
      type: "addNote",
      payload: { title: "다음 생각", content: "생각의 확장", kind: "thought" },
    })
  ).id;
  const records = (
    await source.db.query(
      "SELECT * FROM library_notes WHERE owner_id='original' ORDER BY id",
    )
  ).rows;
  const beforeRecord = resolveThoughtRecord(
    noteFromRow(records.find((r) => r.id === note)!),
  );
  const afterRecord = resolveThoughtRecord(
    noteFromRow(records.find((r) => r.id === after)!),
  );
  const candidate = randomUUID();
  const comparison = {
    relation: "uncertain",
    before: null,
    after: null,
    explanation: "직접 검토할 비교",
  };
  await source.db.query(
    "INSERT INTO library_evolution_candidates(id,owner_id,before_id,after_id,topic_id,before_record,after_record,comparison,provenance,context,pair_key) VALUES($1,'original',$2,$3,$4,$5,$6,$7,$8,$9,'pair')",
    [
      candidate,
      note,
      after,
      child,
      JSON.stringify(beforeRecord),
      JSON.stringify(afterRecord),
      JSON.stringify(comparison),
      JSON.stringify({ promptVersion: "v1", retrievalVersion: "v1" }),
      JSON.stringify([
        {
          id: "context",
          text: "기억할 책",
          source: { kind: "book_metadata", id: book, version: "1", page: null },
          coverage: "metadata",
        },
      ]),
    ],
  );
  await source.db.query(
    "INSERT INTO library_analysis_feedback(id,owner_id,candidate_id,original_output,reason,decision) VALUES($1,'original',$2,$3,'보류','reject')",
    [randomUUID(), candidate, JSON.stringify(comparison)],
  );
  const topicIds = [parent, child].sort();
  await source.db.query(
    "INSERT INTO library_topic_links(id,owner_id,source_topic_id,target_topic_id,status,supporting_pairs) VALUES($1,'original',$2,$3,'suggested',$4)",
    [
      randomUUID(),
      ...topicIds,
      JSON.stringify([{ beforeId: note, afterId: after }]),
    ],
  );
  await store.mutate("unrelated", {
    requestId: randomUUID(),
    type: "addBook",
    payload: { title: "다른 소유자의 책", formats: ["paper"] },
  });
  backup = await createLibraryBackup(source.db, "original");
});
afterAll(async () => {
  await source?.pg.close();
  await target?.pg.close();
});
it("round-trips knowledge, source records, revisions and links exactly into an empty store", async () => {
  const preview = await inspectLibraryBackup(target.db, "restored", backup);
  expect(preview.canRestore).toBe(true);
  expect(preview.counts.library_books).toBe(1);
  expect(preview.counts.library_notes).toBe(2);
  expect(backup.tables.library_books[0]).not.toHaveProperty("owner_id");
  expect(backup.tables).not.toHaveProperty("library_operations");
  expect(backup.tables).not.toHaveProperty("library_analysis_devices");
  await restoreLibraryBackup(target.db, "restored", backup);
  const copy = await createLibraryBackup(target.db, "restored");
  expect(copy.tables).toEqual(backup.tables);
  const data = await createLibraryStore(target.db).snapshot("restored");
  expect(data.books[0].title).toBe("기억할 책");
  expect(data.notes.find((n) => n.id === note)?.content).toBe("내 생각 그대로");
  const thoughts = await createThoughtMapStore(target.db).snapshot("restored");
  expect(thoughts.candidates[0].comparison.relation).toBe("uncertain");
  expect(thoughts.topicLinks[0].supportingPairs).toHaveLength(1);
  const knowledge = await createKnowledgeStore(target.db).snapshot("restored");
  expect(knowledge.items[0].snapshot.note.content).toBe("내 생각 그대로");
  expect(data.cycles[0].startedOn).toBe("2026-01-01");
  expect(
    (await inspectLibraryBackup(target.db, "restored", backup)).canRestore,
  ).toBe(false);
  await expect(
    restoreLibraryBackup(target.db, "restored", backup),
  ).rejects.toMatchObject({ status: 409 });
  expect((await createLibraryBackup(target.db, "restored")).tables).toEqual(
    copy.tables,
  );
});
it("rejects malformed consumer JSON even when resealed, without occupying the target", async () => {
  const cases: [string, string, unknown][] = [
    ["library_notes", "source_data", { app: "iReadItNow" }],
    [
      "library_books",
      "source_data",
      { app: "iReadItNow", raw: {}, sessions: [{ bookmarks: null }] },
    ],
    ["library_books", "classification", { code: { invalid: true } }],
    ["library_books", "enrichment", []],
    ["library_topics", "aliases", {}],
    ["library_topics", "kdc_codes", [{}]],
    ["library_topic_memberships", "evidence", {}],
    ["library_topic_links", "supporting_pairs", [{}]],
    ["library_research_items", "snapshot", { note: null, book: null }],
    ["library_evolution_candidates", "before_record", {}],
    ["library_evolution_candidates", "after_record", { content: [] }],
    ["library_evolution_candidates", "comparison", { relation: "revises" }],
    ["library_evolution_candidates", "provenance", null],
    ["library_evolution_candidates", "context", [{ source: null }]],
    ["library_analysis_feedback", "original_output", {}],
    ["library_analysis_feedback", "corrected_output", []],
    ["library_curation_items", "evidence", { quote: {} }],
    ["library_reference_sources", "facts", []],
  ];
  for (const [table, field, value] of cases) {
    const bad = structuredClone(backup);
    bad.tables[table][0][field] = value;
    seal(bad);
    await expect(
      inspectLibraryBackup(target.db, "malformed", bad),
      `${table}.${field} preview`,
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      restoreLibraryBackup(target.db, "malformed", bad),
      `${table}.${field} restore`,
    ).rejects.toMatchObject({ status: 400 });
    const empty = await createLibraryBackup(target.db, "malformed");
    expect(Object.values(empty.tables).every((rows) => rows.length === 0)).toBe(
      true,
    );
  }
});
it("rejects corruption and unexpected tables or columns, including injected ownership", async () => {
  const bad = structuredClone(backup);
  bad.tables.library_books[0].title = "손상";
  await expect(
    inspectLibraryBackup(target.db, "blank", bad),
  ).rejects.toMatchObject({ status: 400 });
  const extra = structuredClone(backup);
  extra.tables.neon_auth = [{ secret: "x" }];
  seal(extra);
  await expect(
    restoreLibraryBackup(target.db, "blank", extra),
  ).rejects.toMatchObject({ status: 400 });
  const owner = structuredClone(backup);
  owner.tables.library_books[0].owner_id = "original";
  seal(owner);
  await expect(
    restoreLibraryBackup(target.db, "blank", owner),
  ).rejects.toMatchObject({ status: 400 });
  expect(
    (await createLibraryStore(target.db).snapshot("blank")).books,
  ).toHaveLength(0);
});
it("rejects a forged cross-owner connection even with a recomputed checksum", async () => {
  const bad = structuredClone(backup);
  bad.tables.library_connections[0].target_id = randomUUID();
  seal(bad);
  await expect(
    inspectLibraryBackup(target.db, "blank", bad),
  ).rejects.toMatchObject({ status: 400 });
});
it("rolls back every inserted row when a late table violates a database constraint", async () => {
  const empty = await testDatabase();
  try {
    const bad = structuredClone(backup);
    bad.tables.library_curation_items[0].state = "invalid-state";
    seal(bad);
    await expect(
      restoreLibraryBackup(empty.db, "blank", bad),
    ).rejects.toMatchObject({ status: 400 });
    const after = await createLibraryBackup(empty.db, "blank");
    expect(Object.values(after.tables).every((v: any) => v.length === 0)).toBe(
      true,
    );
  } finally {
    await empty.pg.close();
  }
});
