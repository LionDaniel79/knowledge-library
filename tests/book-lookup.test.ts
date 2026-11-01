import { expect, it, vi } from "vitest";
import {
  parseYes24Books,
  parseGoogleBooks,
  parseLibraryKeywords,
  searchBookMetadata,
} from "../src/server/book-lookup";
it("keeps each edition intact, strips markup and enforces ISBN matching", () => {
  const result = parseYes24Books({
    success: true,
    data: {
      items: [
        {
          itemId: 12,
          title: "<b>책</b>",
          author: "저자",
          publisher: "출판사",
          isbn13: "9780306406157",
          cover: "https://image.yes24.com/a.jpg",
          link: "https://www.yes24.com/product/goods/12",
          contentDetail: { bookIntroduction: "소개" },
          pages: 300,
        },
      ],
    },
  });
  expect(result[0]).toMatchObject({
    title: "책",
    isbn: "9780306406157",
    totalPages: 300,
    provider: "yes24",
  });
  expect(
    parseGoogleBooks(
      {
        items: [
          {
            id: "v1",
            volumeInfo: {
              title: "다른 판본",
              industryIdentifiers: [
                { type: "ISBN_13", identifier: "9780140449136" },
              ],
            },
          },
        ],
      },
      "9780306406157",
    ),
  ).toEqual([]);
  expect(
    parseGoogleBooks(
      {
        items: [
          {
            id: "v1",
            volumeInfo: {
              title: "같은 책",
              industryIdentifiers: [
                { type: "ISBN_10", identifier: "0306406152" },
              ],
              imageLinks: { thumbnail: "javascript:alert(1)" },
            },
          },
        ],
      },
      "9780306406157",
    )[0],
  ).toMatchObject({ isbn: "9780306406157", coverUrl: "" });
});
it("falls back after provider errors, does not expose keys, and uses fixed service URLs", async () => {
  const request = vi.fn(async (url: URL | string) =>
    String(url).includes("yes24")
      ? new Response("denied", { status: 403 })
      : String(url).includes("googleapis")
        ? Response.json({
            items: [
              { id: "v", volumeInfo: { title: "책", authors: ["저자"] } },
            ],
          })
        : Response.json({ docs: [] }),
  );
  const result = await searchBookMetadata("책 제목", {
    fetcher: request as typeof fetch,
    yes24Key: "private-test-key",
    googleKey: "",
  });
  expect(result.items[0].title).toBe("책");
  expect(result.warnings.join()).not.toContain("private-test-key");
  expect(result.warnings.join()).toContain("예스24");
  expect(
    request.mock.calls.every(([u]) => !String(u).includes("private-test-key")),
  ).toBe(true);
});

it("reads real library keyword fields and safely applies only matching-edition publisher subjects", async () => {
  expect(
    parseLibraryKeywords({
      response: {
        items: {
          item: [
            { word: "상담", weight: 4 },
            { word: "목회", weight: 3 },
            { word: "상담" },
          ],
        },
      },
    }),
  ).toEqual(["상담", "목회"]);
  const isbn = "9780306406157";
  const fetcher = vi.fn(async (url: URL | string) =>
    String(url).includes("yes24")
      ? Response.json({
          success: true,
          data: {
            items: [
              {
                itemId: 15,
                title: "상담과 믿음",
                isbn13: isbn,
                author: "저자",
                publisher: "출판사",
              },
            ],
          },
        })
      : Response.json({
          items: [
            {
              id: "matching",
              volumeInfo: {
                title: "상담과 믿음",
                industryIdentifiers: [{ identifier: isbn }],
                categories: ["Religion / Christian Ministry"],
              },
            },
            {
              id: "other",
              volumeInfo: {
                title: "다른 판본",
                industryIdentifiers: [{ identifier: "9780140449136" }],
                categories: ["History"],
              },
            },
          ],
        }),
  );
  const result = await searchBookMetadata(isbn, {
    fetcher: fetcher as typeof fetch,
    yes24Key: "local-test-key",
    libraryKey: "",
  });
  expect(result.items).toHaveLength(1);
  expect(result.items[0]).toMatchObject({
    isbn,
    provider: "yes24",
    category: "200",
    tags: ["Religion / Christian Ministry"],
  });
  expect(result.items[0].tags).not.toContain("History");
});
