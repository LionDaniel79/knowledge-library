import { expect, it } from "vitest";
import { bookInput, formatNames } from "../src/lib/domain";
import { readStartup, writeStartup } from "../src/client/replica/startup-cache";
import { previewLibrary } from "../src/lib/preview-data";
import { queryBooks, type LocalIndex } from "../src/client/replica/queries";
it("accepts logos and exposes the exact ownership format order", () => {
  expect(
    bookInput.parse({
      title: "도서",
      formats: ["paper", "logos", "ebook", "pdf", "unknown"],
    }).formats,
  ).toEqual(["paper", "logos", "ebook", "pdf", "unknown"]);
  expect(Object.entries(formatNames)).toEqual([
    ["paper", "종이책"],
    ["logos", "로고스"],
    ["ebook", "전자책"],
    ["pdf", "PDF"],
    ["unknown", "형식 확인 필요"],
  ]);
});
it("keeps logos snapshots and reads older startup count maps without resetting device data", () => {
  const cache = new Map<string, string>(),
    storage = {
      getItem: (k: string) => cache.get(k) ?? null,
      setItem: (k: string, v: string) => {
        cache.set(k, v);
      },
      removeItem: (k: string) => {
        cache.delete(k);
      },
    };
  const library = structuredClone(previewLibrary);
  library.books[0].formats = ["logos"] as any;
  writeStartup(storage, "owner", library);
  expect(readStartup(storage, "owner")?.books[0].formats).toEqual(["logos"]);
  const old = {
    ...library,
    catalog: {
      total: 1,
      formatCounts: { paper: 0, ebook: 1, pdf: 0, unknown: 0 },
      categoryCounts: {},
      firstPage: {
        items: library.books.slice(0, 1),
        total: 1,
        nextCursor: null,
      },
    },
  };
  cache.set(
    "knowledge-library-startup:v1:owner",
    JSON.stringify({ version: 1, owner: "owner", library: old }),
  );
  expect(readStartup(storage, "owner")?.catalog?.formatCounts.logos).toBe(0);
});
it("filters offline logos independently from ordinary ebooks", async () => {
  const books = ["logos", "ebook"].map((format, i) => ({
    book: { ...previewLibrary.books[i], formats: [format] as any },
    createdKey: "2026-11-01",
    createdSql: "2026-11-01",
  }));
  const data: LocalIndex = {
    books,
    notes: [],
    previews: {},
    cycles: [],
    excluded: [],
    trash: {},
    shelves: [],
    annualMetrics: [],
    topics: [],
    memberships: [],
    topicLinks: [],
    entries: [],
  };
  expect(
    (await queryBooks(data, "owner", { filter: "logos" })).items.map(
      (b) => b.id,
    ),
  ).toEqual([books[0].book.id]);
  expect(
    (await queryBooks(data, "owner", { filter: "ebook" })).items.map(
      (b) => b.id,
    ),
  ).toEqual([books[1].book.id]);
});
