import { it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { createLibraryStore } from "../src/server/library-store";
import { createCurationStore } from "../src/server/curation-store";
import { searchLibrary } from "../src/server/library-search";
import { createThoughtMapStore } from "../src/server/thought-map-store";
let f: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  f = await testDatabase();
});
afterAll(async () => f?.pg.close());
it("finds title spacing variants without rewriting the stored title or source excerpt", async () => {
  const owner = "spacing-search",
    l = createLibraryStore(f.db);
  const book = await l.mutate(owner, {
    requestId: randomUUID(),
    type: "addBook",
    payload: {
      title: "인간 본성의 4중 상태",
      author: "토마스 보스턴",
      formats: ["paper"],
    },
  });
  for (const text of ["인간 본성의 4중상태", "인간본성의4중상태"]) {
    const result = await searchLibrary(f.db, owner, { text, layer: "all" });
    expect(result.items).toEqual([
      expect.objectContaining({
        source: expect.objectContaining({ id: book.id }),
        title: "인간 본성의 4중 상태",
        quote: expect.stringContaining("토마스 보스턴"),
        matchedTerms: [text],
      }),
    ]);
    expect(
      (await searchLibrary(f.db, "spacing-outsider", { text, layer: "all" }))
        .items,
    ).toEqual([]);
  }
});
it("finds manually written thought-change explanations and stops showing withdrawn judgments", async () => {
  const l = createLibraryStore(f.db),
    t = createThoughtMapStore(f.db),
    owner = "judgments";
  const cmd = (type: string, payload: any) => ({
    requestId: randomUUID(),
    type,
    payload,
  });
  const before = await l.mutate(
    owner,
    cmd("addNote", {
      title: "처음",
      content: "감정이 어렵다.",
      kind: "thought",
    }),
  );
  const after = await l.mutate(
    owner,
    cmd("addNote", {
      title: "나중",
      content: "감정을 수용한다.",
      kind: "thought",
    }),
  );
  await t.mutate(
    owner,
    cmd("setThoughtEvent", {
      noteId: before.id,
      expectedVersion: 0,
      occurredOn: "2020-01-01",
      voice: "self",
    }),
  );
  await t.mutate(
    owner,
    cmd("setThoughtEvent", {
      noteId: after.id,
      expectedVersion: 0,
      occurredOn: "2021-01-01",
      voice: "self",
    }),
  );
  const linked = await t.mutate(
    owner,
    cmd("connectThoughts", {
      beforeId: before.id,
      afterId: after.id,
      relation: "revises",
      explanation: "대화경험이준관점의전환",
    }),
  );
  for (const layer of ["mine", "all"] as const)
    expect(
      (
        await searchLibrary(f.db, owner, {
          text: "대화경험이준관점의전환",
          layer,
        })
      ).items,
    ).toEqual([
      expect.objectContaining({
        layer: "mine",
        origin: "human",
        quote: "대화경험이준관점의전환",
      }),
    ]);
  expect(
    (
      await searchLibrary(f.db, "outsider", {
        text: "대화경험이준관점의전환",
        layer: "all",
      })
    ).items,
  ).toHaveLength(0);
  await t.mutate(
    owner,
    cmd("decideCandidate", {
      id: linked.id,
      expectedVersion: linked.version,
      decision: "reopen",
      relation: "revises",
      explanation: "대화경험이준관점의전환",
      reason: "other",
    }),
  );
  expect(
    (
      await searchLibrary(f.db, owner, {
        text: "대화경험이준관점의전환",
        layer: "all",
      })
    ).items,
  ).toHaveLength(0);
  // Accepting generated wording does not make it the user's writing.
  await f.db.query(
    "UPDATE library_evolution_candidates SET provenance=$2 WHERE id=$1",
    [linked.id, JSON.stringify({ provider: "openai", model: "gpt-6-luna" })],
  );
  await t.mutate(
    owner,
    cmd("decideCandidate", {
      id: linked.id,
      expectedVersion: 2,
      decision: "accept",
      relation: "revises",
      explanation: "대화경험이준관점의전환",
      reason: "relevant",
    }),
  );
  expect(
    (
      await searchLibrary(f.db, owner, {
        text: "대화경험이준관점의전환",
        layer: "mine",
      })
    ).items,
  ).toHaveLength(0);
  await t.mutate(
    owner,
    cmd("decideCandidate", {
      id: linked.id,
      expectedVersion: 3,
      decision: "accept",
      relation: "revises",
      explanation: "직접수정한판단이유",
      reason: "relevant",
    }),
  );
  expect(
    (
      await searchLibrary(f.db, owner, {
        text: "직접수정한판단이유",
        layer: "mine",
      })
    ).items,
  ).toEqual([expect.objectContaining({ origin: "human" })]);
});
it("prioritizes personal text, separates imported quotations and auxiliary data, respects hiding and owner", async () => {
  const l = createLibraryStore(f.db),
    c = createCurationStore(f.db),
    owner = "search";
  const n = await l.mutate(owner, {
    requestId: randomUUID(),
    type: "addNote",
    payload: {
      title: "내 글",
      content: "감정은 관계 속에서 이해한다.",
      kind: "thought",
    },
  });
  const b = await l.mutate(owner, {
    requestId: randomUUID(),
    type: "addBook",
    payload: { title: "관계와 감정", formats: ["paper"] },
  });
  const q = await l.mutate(owner, {
    requestId: randomUUID(),
    type: "addNote",
    payload: {
      title: "가져온 구절",
      content: "감정에 관한 책의 말",
      kind: "note",
    },
  });
  await f.db.query("UPDATE library_notes SET source_data=$2 WHERE id=$1", [
    q.id,
    JSON.stringify({ app: "iReadItNow HD" }),
  ]);
  const run = await c.begin(owner, "test", "rule");
  const id = randomUUID();
  await c.apply(owner, run, [
    {
      id,
      source: { kind: "book", id: b.id!, version: "1" },
      kind: "tag",
      proposedValue: "감정",
      evidence: { quote: "감정" },
      coverage: "metadata",
      origin: "rule",
      generator: "test",
    },
  ]);
  const all = await searchLibrary(f.db, owner, { text: "감정", layer: "all" });
  expect(all.items[0]).toMatchObject({ layer: "mine", source: { id: n.id } });
  expect(all.items.find((x) => x.source.id === q.id)?.voice).toBe(
    "unconfirmed",
  );
  expect(
    (await searchLibrary(f.db, owner, { text: "감정", layer: "mine" })).items,
  ).toHaveLength(1);
  expect(
    (await searchLibrary(f.db, "other", { text: "감정", layer: "all" })).items,
  ).toHaveLength(0);
  expect(
    (await searchLibrary(f.db, owner, { text: "감정", layer: "auxiliary" }))
      .items,
  ).toHaveLength(1);
  await c.edit(owner, id, 1, { value: "감정", state: "hidden" });
  expect(
    (await searchLibrary(f.db, owner, { text: "감정", layer: "auxiliary" }))
      .items,
  ).toHaveLength(0);
  expect((await l.snapshot(owner)).notes).toHaveLength(2);
  expect(
    (await searchLibrary(f.db, owner, { text: "%", layer: "all" })).items,
  ).toHaveLength(0);
});
it("paginates deterministically and rejects a cursor from another query", async () => {
  const l = createLibraryStore(f.db);
  for (let i = 0; i < 25; i++)
    await l.mutate("pages", {
      requestId: randomUUID(),
      type: "addBook",
      payload: { title: `검색책 ${i}`, formats: ["paper"] },
    });
  const first = await searchLibrary(f.db, "pages", {
    text: "검색책",
    layer: "all",
  });
  expect(first.items).toHaveLength(20);
  const second = await searchLibrary(f.db, "pages", {
    text: "검색책",
    layer: "all",
    cursor: first.nextCursor!,
  });
  expect(second.items).toHaveLength(5);
  expect(new Set([...first.items, ...second.items].map((x) => x.id)).size).toBe(
    25,
  );
  await expect(
    searchLibrary(f.db, "pages", {
      text: "다른책",
      layer: "all",
      cursor: first.nextCursor!,
    }),
  ).rejects.toThrow();
  await expect(
    searchLibrary(f.db, "pages", {
      text: "검색책",
      layer: "all",
      expandAliases: true,
      cursor: first.nextCursor!,
    }),
  ).rejects.toThrow();
});

it("expands only confirmed exact topic aliases and explains the matched wording", async () => {
  const l = createLibraryStore(f.db),
    owner = "aliases";
  const note = await l.mutate(owner, {
    requestId: randomUUID(),
    type: "addNote",
    payload: {
      title: "기록",
      content: "정서의 움직임을 관찰한다.",
      kind: "thought",
    },
  });
  for (const [who, name, aliases, confirmed] of [
    [owner, "정서", ["감정", "emotion"], true],
    [owner, "숨은말", ["비공개별칭"], false],
    ["another", "정서", ["타인표현"], true],
  ] as const)
    await f.db.query(
      "INSERT INTO library_topics(id,owner_id,name,aliases,confirmed) VALUES($1,$2,$3,$4,$5)",
      [randomUUID(), who, name, JSON.stringify(aliases), confirmed],
    );
  expect(
    (await searchLibrary(f.db, owner, { text: "감정", layer: "all" })).items,
  ).toHaveLength(0);
  const expanded = await searchLibrary(f.db, owner, {
    text: "감정",
    layer: "all",
    expandAliases: true,
  });
  expect(expanded.items).toEqual([
    expect.objectContaining({
      source: { kind: "note", id: note.id, version: "1" },
      quote: "정서의 움직임을 관찰한다.",
      matchedTerms: ["정서"],
    }),
  ]);
  for (const text of ["타인표현", "비공개별칭", "감정의 변화"])
    expect(
      (
        await searchLibrary(f.db, owner, {
          text,
          layer: "all",
          expandAliases: true,
        })
      ).items,
    ).toHaveLength(0);
});

it("limits topic expansion to confirmed descendants and one accepted link, with current owner memberships", async () => {
  const l = createLibraryStore(f.db),
    owner = "topic-scope";
  const ids = Array.from({ length: 7 }, () => randomUUID());
  for (let i = 0; i < ids.length; i++)
    await f.db.query(
      "INSERT INTO library_topics(id,owner_id,name,parent_id,confirmed) VALUES($1,$2,$3,$4,$5)",
      [ids[i], owner, `주제${i}`, i === 1 || i === 6 ? ids[0] : null, i !== 6],
    );
  for (const [a, b, status] of [
    [0, 2, "accepted"],
    [0, 3, "suggested"],
    [0, 4, "rejected"],
    [2, 5, "accepted"],
  ] as const) {
    const [one, two] = [ids[a], ids[b]].sort();
    await f.db.query(
      "INSERT INTO library_topic_links(id,owner_id,source_topic_id,target_topic_id,status) VALUES($1,$2,$3,$4,$5)",
      [randomUUID(), owner, one, two, status],
    );
  }
  const notes: string[] = [];
  for (let i = 0; i < 11; i++) {
    const who = i === 8 ? "other-scope" : owner;
    const n = await l.mutate(who, {
      requestId: randomUUID(),
      type: "addNote",
      payload: { title: `기록${i}`, content: "같은 검색어", kind: "thought" },
    });
    notes.push(n.id!);
    if (i !== 8)
      await f.db.query(
        "INSERT INTO library_topic_memberships(id,owner_id,topic_id,source_kind,source_id,source_version,status,method) VALUES($1,$2,$3,'note',$4,$5,$6,'manual')",
        [
          randomUUID(),
          owner,
          ids[i < 7 ? i : 0],
          n.id,
          i === 7 ? "0" : "1",
          i === 9 ? "suggested" : i === 10 ? "rejected" : "accepted",
        ],
      );
  }
  const search = (scope: "exact" | "children" | "related") =>
    searchLibrary(f.db, owner, {
      text: "검색어",
      layer: "all",
      topicId: ids[0],
      topicScope: scope,
    });
  expect((await search("exact")).items.map((x) => x.source.id)).toEqual([
    notes[0],
  ]);
  expect(
    (await search("children")).items.map((x) => x.source.id).sort(),
  ).toEqual(notes.slice(0, 2).sort());
  const related = await search("related");
  expect(related.items.map((x) => x.source.id).sort()).toEqual(
    notes.slice(0, 3).sort(),
  );
  expect(
    related.items.find((x) => x.source.id === notes[2])?.topicMatches,
  ).toEqual([{ id: ids[2], name: "주제2", relation: "related" }]);
  await expect(
    searchLibrary(f.db, "other-scope", {
      text: "",
      layer: "all",
      topicId: ids[0],
      topicScope: "related",
    }),
  ).rejects.toThrow();
  await f.db.query(
    "UPDATE library_topic_memberships SET status='rejected' WHERE source_id=$1",
    [notes[0]],
  );
  expect((await search("exact")).items).toHaveLength(0);
});
