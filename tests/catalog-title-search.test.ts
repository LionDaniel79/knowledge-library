import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  lookupLibraryTitle,
  parseLibraryTitleSearch,
} from "../src/server/catalog-provider";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it("returns candidate editions from the documented srchBooks wrapper without treating them as confirmed", () => {
  const result = parseLibraryTitleSearch({
    response: {
      numFound: 2,
      docs: [
        {
          doc: {
            bookname: "마음",
            isbn13: "9780306406157",
            authors: "저자",
            publisher: "출판사",
            vol: "2",
            publication_year: "2020",
          },
        },
        { doc: { bookname: "손상 번호", isbn13: "9780306406158" } },
      ],
    },
  });
  expect(result.numFound).toBe(2);
  expect(result.books).toHaveLength(1);
  expect(result.books[0]).toMatchObject({
    isbn: "9780306406157",
    title: "마음",
    volume: "2",
    publicationYear: "2020",
  });
  expect(() =>
    parseLibraryTitleSearch({ response: { error: "authKey=secret" } }),
  ).toThrow("거부");
  expect(() => parseLibraryTitleSearch({ response: {} })).toThrow();
});
it("never performs a catalogue-wide query and sends only the bounded title query", async () => {
  vi.stubEnv(
    "CATALOG_API_USAGE_PATH",
    join(mkdtempSync(join(tmpdir(), "title-quota-")), "usage.sqlite"),
  );
  vi.stubEnv("DATA4LIBRARY_DAILY_LIMIT", "450");
  const fetcher = vi.fn(
    async (_input: unknown) =>
      new Response(JSON.stringify({ response: { numFound: 0, docs: [] } }), {
        status: 200,
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  await expect(lookupLibraryTitle("  ", "private-key")).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
  expect(await lookupLibraryTitle("마음의 이해", "private-key")).toMatchObject({
    numFound: 0,
    books: [],
  });
  const url = new URL(String(fetcher.mock.calls[0][0]));
  expect(url.pathname).toBe("/api/srchBooks");
  expect(url.searchParams.get("title")).toBe("마음의 이해");
  expect(url.searchParams.get("pageSize")).toBe("10");
  expect(url.searchParams.get("pageNo")).toBe("1");
  await lookupLibraryTitle("35) 히브리서 [개정판]", "private-key");
  expect(
    new URL(String(fetcher.mock.calls[1][0])).searchParams.get("title"),
  ).toBe("35 히브리서 개정판");
  await expect(lookupLibraryTitle("(*)", "private-key")).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(2);
  fetcher.mockImplementation(async () => new Response("", { status: 200 }));
  await expect(lookupLibraryTitle("히브리서", "private-key")).rejects.toThrow(
    "응답 형식",
  );
});
