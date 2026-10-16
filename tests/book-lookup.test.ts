import { expect, it, vi } from "vitest";
import {
  parseYes24Books,
  parseGoogleBooks,
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
