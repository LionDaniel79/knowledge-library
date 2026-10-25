import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { readBookPage } from "../src/server/book-catalog";
import { queryBooks, type LocalIndex } from "../src/client/replica/queries";
import {
  projectBook,
  timestampKey,
  sqlTimestamp,
} from "../src/lib/replica/projections";

let f: Awaited<ReturnType<typeof testDatabase>>, data: LocalIndex;
const owner = "comma-title-search",
  first = randomUUID(),
  second = randomUUID(),
  excluded = randomUUID(),
  sharp = randomUUID();
beforeAll(async () => {
  f = await testDatabase();
  for (const [id, title] of [
    [first, "우주, 시간, 그 너머"],
    [second, "우주 시간 그 너머"],
    [excluded, "우주시간 그너머"],
    [sharp, "C# 프로그래밍"],
    [randomUUID(), "C++ 프로그래밍"],
  ])
    await f.db.query(
      "INSERT INTO library_books(id,owner_id,title,formats) VALUES($1,$2,$3,ARRAY['paper'])",
      [id, owner, title],
    );
  await f.db.query(
    "INSERT INTO library_book_exclusions(id,owner_id,kind,reason,batch_id) VALUES($1,$2,'periodical','제외 자료',$3)",
    [excluded, owner, randomUUID()],
  );
  const rows = (
    await f.db.query("SELECT * FROM library_books WHERE owner_id=$1", [owner])
  ).rows;
  data = {
    books: rows.map((r) => ({
      book: projectBook(r),
      createdKey: timestampKey(r.created_at),
      createdSql: sqlTimestamp(r.created_at),
    })),
    notes: [],
    previews: {},
    cycles: [],
    excluded: [excluded],
    trash: {},
    shelves: [],
    annualMetrics: [],
    topics: [],
    memberships: [],
    topicLinks: [],
    entries: [],
  };
});
afterAll(async () => {
  await f?.pg.close();
});

it.each([
  "우주시간",
  "우주 시간",
  "우주, 시간",
  "우주,시간",
  "우주，시간",
  "우주시간그너머",
])(
  "finds comma and spacing variants of %s in both server and device book search",
  async (text) => {
    for (const query of [{ q: text }, { title: text }]) {
      const server = await readBookPage(f.db, owner, query),
        device = await queryBooks(data, owner, query);
      expect(server.items.map((b) => b.id).sort()).toEqual(
        [first, second].sort(),
      );
      expect(device.items.map((b) => b.id).sort()).toEqual(
        [first, second].sort(),
      );
      expect(server.total).toBe(2);
      expect(device.total).toBe(2);
      expect(server.items.find((b) => b.id === first)?.title).toBe(
        "우주, 시간, 그 너머",
      );
    }
  },
);

it("retains literal punctuation-only searches, meaningful symbols and ownership boundaries", async () => {
  for (const query of [{ q: "," }, { title: "," }]) {
    expect(
      (await readBookPage(f.db, owner, query)).items.map((b) => b.id),
    ).toEqual([first]);
    expect(
      (await queryBooks(data, owner, query)).items.map((b) => b.id),
    ).toEqual([first]);
  }
  for (const query of [{ q: "%_" }, { q: "없는책" }]) {
    expect((await readBookPage(f.db, owner, query)).total).toBe(0);
    expect((await queryBooks(data, owner, query)).total).toBe(0);
  }
  expect(
    (await readBookPage(f.db, owner, { q: "C#" })).items.map((b) => b.id),
  ).toEqual([sharp]);
  expect(
    (await queryBooks(data, owner, { q: "C#" })).items.map((b) => b.id),
  ).toEqual([sharp]);
  expect(
    (await readBookPage(f.db, "other-owner", { q: "우주시간" })).total,
  ).toBe(0);
});
