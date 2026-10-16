import { expect, it } from "vitest";
import { mapLegacyReading } from "../src/lib/legacy-reading";
import type { Book } from "../src/lib/domain";

const book = (statusCode: number, sessions: any[]): Book => ({
  id: "00000000-0000-4000-a000-000000000001",
  title: "책",
  author: "",
  publisher: "",
  isbn: "",
  formats: ["paper"],
  totalPages: 300,
  shelf: "",
  tags: [],
  version: 1,
  createdAt: "2026-01-01",
  sourceData: {
    app: "iReadItNow HD",
    libraryId: "library",
    recordId: "book",
    statusCode,
    raw: {},
    sessions,
  },
});
const session = (
  sourceId: string,
  statusCode: number,
  endedOn: string | null,
) => ({
  sourceId,
  statusCode,
  startedOn: "2026-01-01",
  endedOn,
  bookmarks: [],
  raw: {},
});

it("imports each completed reading including rereads, without treating abandoned sessions as finished", () => {
  const mapped = mapLegacyReading([
    book(32, [
      session("one", 2, "2026-01-03"),
      session("two", 2, "2026-02-03"),
      session("stopped", 3, "2026-01-02"),
      session("stale", 0, null),
    ]),
  ]);
  expect(mapped.map((x) => [x.status, x.completedOn])).toEqual([
    ["completed", "2026-01-03"],
    ["completed", "2026-02-03"],
  ]);
  expect(new Set(mapped.map((x) => x.sourceKey)).size).toBe(2);
});
it("uses confirmed currently-reading books and the latest recorded page rather than a maximum", () => {
  const current = session("current", 0, null);
  const b = book(4, [
    {
      ...current,
      bookmarks: [
        { sourceId: "a", page: 100, recordedAt: "2026-01-02" },
        { sourceId: "b", page: 80, recordedAt: "2026-01-03" },
      ],
    },
  ]);
  expect(mapLegacyReading([b])).toMatchObject([
    { status: "reading", currentPage: 80, completedOn: null },
  ]);
  expect(mapLegacyReading([book(8, [session("paused", 1, null)])])).toEqual([]);
});
it("does not invent a completion date or accept a reversed period", () => {
  expect(
    mapLegacyReading([
      book(32, [session("undated", 2, null), session("bad", 2, "2025-12-01")]),
    ]),
  ).toEqual([]);
});
