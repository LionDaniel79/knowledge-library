import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { createKnowledgeStore } from "../src/server/knowledge-store";
import { createLibraryStore } from "../src/server/library-store";
import {
  packOutline,
  unpackOutline,
  exportResearchText,
} from "../src/lib/writing";
let f: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  f = await testDatabase();
});
afterAll(async () => {
  await f?.pg.close();
});
const cmd = (type: string, payload: unknown) => ({
  requestId: randomUUID(),
  type,
  payload,
});
it("round-trips a readable outline and exports plain text with its source", () => {
  const question = packOutline("왜 변했나?", ["첫 생각", "새 근거"]);
  expect(unpackOutline(packOutline("", ["질문 없는 첫 장"]).trim())).toEqual({
    question: "",
    outline: ["질문 없는 첫 장"],
  });
  expect(unpackOutline(question)).toEqual({
    question: "왜 변했나?",
    outline: ["첫 생각", "새 근거"],
  });
  expect(unpackOutline("옛 질문")).toEqual({
    question: "옛 질문",
    outline: [],
  });
  expect(
    exportResearchText(
      { title: "글", question },
      [
        {
          id: "x",
          snapshot: {
            note: {
              title: "메모",
              content: "내 문장",
              kind: "thought",
              page: null,
              version: 1,
            },
            book: null,
          },
        },
      ],
      [],
    ),
  ).toContain("출처: 나의 생각");
});
it("updates project metadata with compare-and-swap and preserves concurrent edits", async () => {
  const owner = randomUUID(),
    s = createKnowledgeStore(f.db),
    p = await s.mutate(
      owner,
      cmd("createResearch", {
        title: "옛 제목",
        kind: "thesis",
        question: "질문",
      }),
    );
  await s.mutate(
    owner,
    cmd("updateResearch", {
      id: p.id,
      title: "새 제목",
      question: "목차",
      expectedTitle: "옛 제목",
      expectedQuestion: "질문",
    }),
  );
  await expect(
    s.mutate(
      owner,
      cmd("updateResearch", {
        id: p.id,
        title: "덮어쓰기",
        question: "x",
        expectedTitle: "옛 제목",
        expectedQuestion: "질문",
      }),
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect((await s.snapshot(owner)).research[0].title).toBe("새 제목");
});
it("reloads an outline from the actual store when the optional research question is empty", async () => {
  const owner = randomUUID(),
    s = createKnowledgeStore(f.db);
  const created = await s.mutate(
    owner,
    cmd("createResearch", {
      title: "질문 없는 목차",
      kind: "thesis",
      question: packOutline("", ["첫 장", "둘째 장"]),
    }),
  );
  const saved = (await s.snapshot(owner)).research.find(
    (r) => r.id === created.id,
  )!;
  expect(unpackOutline(saved.question)).toEqual({
    question: "",
    outline: ["첫 장", "둘째 장"],
  });
  await s.mutate(
    owner,
    cmd("updateResearch", {
      id: created.id,
      title: saved.title,
      expectedTitle: saved.title,
      expectedQuestion: saved.question,
      question: packOutline("", ["새 목차"]),
    }),
  );
  expect(
    unpackOutline((await s.snapshot(owner)).research[0].question).outline,
  ).toEqual(["새 목차"]);
});
it("swaps two placements atomically and rolls both back on stale or foreign peer", async () => {
  const owner = randomUUID(),
    s = createKnowledgeStore(f.db),
    l = createLibraryStore(f.db),
    p = await s.mutate(
      owner,
      cmd("createResearch", { title: "글", kind: "thesis", question: "" }),
    );
  const ids = [];
  for (const content of ["a", "b"]) {
    const n = await l.mutate(owner, cmd("addNote", { content }));
    ids.push(
      (
        await s.mutate(
          owner,
          cmd("addResearchNote", { researchId: p.id, noteId: n.id }),
        )
      ).id,
    );
  }
  const payload = {
    items: ids.map((itemId, i) => ({
      itemId,
      expectedVersion: 0,
      position: 2 - i,
    })),
  };
  const request = cmd("moveResearchItems", payload);
  await s.mutate(owner, request);
  await s.mutate(owner, request);
  expect(
    (await s.snapshot(owner)).placements.map((p) => p.position).sort(),
  ).toEqual([1, 2]);
  await expect(
    s.mutate(
      owner,
      cmd("moveResearchItems", {
        items: [
          { itemId: ids[0], expectedVersion: 1, position: 9 },
          { itemId: ids[1], expectedVersion: 0, position: 8 },
        ],
      }),
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect(
    (await s.snapshot(owner)).placements.map((p) => p.position).sort(),
  ).toEqual([1, 2]);
  await expect(
    s.mutate(
      owner,
      cmd("moveResearchItems", {
        items: [
          { itemId: ids[0], expectedVersion: 1, position: 9 },
          { itemId: randomUUID(), expectedVersion: 0, position: 8 },
        ],
      }),
    ),
  ).rejects.toMatchObject({ status: 404 });
});
