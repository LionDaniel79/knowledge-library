import { afterAll, beforeAll, expect, it } from "vitest";
import { testDatabase } from "./helpers/database";
import { readCyclePage } from "../src/server/record-catalog";
import { queryReading, type LocalIndex } from "../src/client/replica/queries";
import type { Book, ReadingCycle } from "../src/lib/domain";
import {
  recentCompletedCycles,
  recentReadingStart,
} from "../src/lib/recent-reading";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const owner = "recent-reading-owner";
const fixtures = [
  [1, 1, "2026-11-11", "completed"],
  [2, 1, "2026-11-10", "completed"],
  [3, 2, "2026-10-13", "completed"],
  [4, 3, "2026-10-12", "completed"],
  [5, 4, "2026-11-12", "completed"],
  [6, 5, null, "completed"],
  [7, 6, null, "reading"],
  [8, 7, "2026-11-11", "completed"],
  [9, 8, "2026-11-11", "completed"],
  [10, 8, "2026-11-11", "completed"],
] as const;
let f: Awaited<ReturnType<typeof testDatabase>>;
const local = {
  books: Array.from({ length: 8 }, (_, i) => ({
    book: { id: id(i + 1), title: `Book ${i + 1}` } as Book,
    createdKey: "",
    createdSql: "",
  })),
  cycles: fixtures.map(
    ([n, book, day, status]) =>
      ({
        id: id(n),
        bookId: id(book),
        completedOn: day,
        status,
        startedOn: null,
        currentPage: 0,
        version: 1,
        createdAt: "2026-01-01T00:00:00Z",
      }) satisfies ReadingCycle,
  ),
  excluded: [id(7)],
} as LocalIndex;
beforeAll(async () => {
  f = await testDatabase();
  for (let n = 1; n <= 8; n++)
    await f.db.query(
      "INSERT INTO library_books(id,owner_id,title,formats) VALUES($1,$2,$3,ARRAY['paper'])",
      [id(n), owner, `Book ${n}`],
    );
  for (const cycle of local.cycles)
    await f.db.query(
      "INSERT INTO library_cycles(id,owner_id,book_id,status,completed_on) VALUES($1,$2,$3,$4,$5)",
      [cycle.id, owner, cycle.bookId, cycle.status, cycle.completedOn],
    );
  await f.db.query(
    "INSERT INTO library_book_exclusions(id,owner_id,kind,reason,batch_id) VALUES($1,$2,'paper','fixture',$3)",
    [id(7), owner, id(99)],
  );
}, 60000);
afterAll(async () => {
  await f?.pg.close();
});

it.each(["server", "replica"])(
  "%s filters inclusive 30 days, excludes protected books, and deduplicates before paging",
  async (source) => {
    const read = (offset: number) =>
      source === "server"
        ? readCyclePage(f.db, owner, {
            recentThrough: "2026-11-11",
            limit: 2,
            offset,
          })
        : queryReading(local, {
            recentThrough: "2026-11-11",
            limit: 2,
            offset,
          });
    const first = await read(0);
    expect(first.items.map((c) => c.id)).toEqual([id(1), id(9)]);
    expect(first.books.map((b) => b.id).sort()).toEqual([id(1), id(8)]);
    expect(first.total).toBe(3);
    expect(first.nextOffset).toBe(2);
    const second = await read(2);
    expect(second.items.map((c) => c.id)).toEqual([id(3)]);
    expect(second.total).toBe(3);
    expect(second.nextOffset).toBeNull();
    expect((await read(3)).items).toEqual([]);
  },
);

it.each([
  ["2024-03-01", "2024-02-01"],
  ["2025-03-01", "2025-01-31"],
  ["2026-01-01", "2025-12-03"],
])(
  "uses thirty calendar days through %s across month and year boundaries",
  (today, start) => {
    expect(recentReadingStart(today)).toBe(start);
  },
);

it("selects the latest completed cycle without mutating source order", () => {
  const source = [
    local.cycles[1],
    local.cycles[0],
    local.cycles[9],
    local.cycles[8],
  ];
  expect(recentCompletedCycles(source, "2026-11-11").map((c) => c.id)).toEqual([
    id(1),
    id(9),
  ]);
  expect(source.map((c) => c.id)).toEqual([id(2), id(1), id(10), id(9)]);
});

it.each(["2026-02-30", "2026-13-01", "2026-1-1"])(
  "rejects invalid recentThrough %s consistently",
  async (recentThrough) => {
    await expect(
      readCyclePage(f.db, owner, { recentThrough }),
    ).rejects.toThrow();
    expect(() => queryReading(local, { recentThrough })).toThrow();
  },
);
