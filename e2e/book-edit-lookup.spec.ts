import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { previewLibrary } from "../src/lib/preview-data";
import type { BookCandidate } from "../src/lib/book-lookup";

const book = {
  ...previewLibrary.books[0],
  title: "기존 소장본",
  isbn: "9780306406157",
  category: "100",
  coverUrl: "https://library.test/old-cover.png",
  bookshelves: ["책 대기열"],
  formats: ["pdf"],
  shelf: "E:/나의 PDF/원본.pdf",
};
const candidate: BookCandidate = {
  id: "lookup-book",
  title: "확인한 제목",
  author: "확인한 저자",
  publisher: "확인한 출판사",
  isbn: "9780131103627",
  coverUrl: "https://library.test/new-cover.png",
  totalPages: 321,
  category: "200",
  provider: "google",
  sourceUrl: "https://books.google.com/books?id=fixture",
  description: "검색으로 확인한 도서 소개",
};
let bundle: string;
test.beforeAll(async () => {
  bundle = (
    await build({
      stdin: {
        contents: `import {createRoot} from 'react-dom/client';import {LibraryForm} from './src/components/library-forms';createRoot(document.getElementById('root')).render(<LibraryForm editor={window.editor} library={window.library} today="2026-10-22" preview={false} onClose={()=>window.closedForm=true} onSave={async c=>{window.commands.push(c)}}/>);`,
        loader: "tsx",
        resolveDir: process.cwd(),
      },
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
    })
  ).outputFiles[0].text;
});

async function open(
  page: Page,
  edit = true,
  result: BookCandidate = candidate,
) {
  const queries: string[] = [];
  await page.route("https://library.test/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/book-lookup") {
      queries.push(url.searchParams.get("q")!);
      return route.fulfill({ json: { items: [result], warnings: [] } });
    }
    if (route.request().resourceType() === "document")
      return route.fulfill({
        contentType: "text/html",
        body: '<html lang="ko"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>',
      });
    return route.fulfill({ status: 404 });
  });
  await page.goto("https://library.test/");
  await page.evaluate(
    ({ book, edit }) => {
      Object.assign(window, {
        editor: { kind: "book", ...(edit ? { book } : {}) },
        library: { books: [book], notes: [], cycles: [] },
        commands: [],
        closedForm: false,
      });
    },
    { book, edit },
  );
  await page.addStyleTag({ path: "src/app/globals.css" });
  await page.addScriptTag({ content: bundle });
  return queries;
}

test("editing looks up metadata at the top and saves the same PDF without changing personal fields", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const queries = await open(page);
  const lookup = page.getByRole("region", { name: "책 정보 검색" });
  await expect(lookup).toBeVisible();
  await expect(lookup.getByLabel("온라인 도서 검색어")).toHaveValue(book.isbn);
  expect(queries).toEqual([]);
  await expect(
    lookup.getByRole("button", { name: "바코드 스캔" }),
  ).toBeVisible();
  await expect(lookup.getByLabel("바코드 이미지 등록")).toBeVisible();
  expect(
    await lookup.evaluate(
      (el) =>
        !!(
          el.compareDocumentPosition(
            document.querySelector('input[name="title"]')!,
          ) & Node.DOCUMENT_POSITION_FOLLOWING
        ),
    ),
  ).toBe(true);
  await lookup.getByLabel("온라인 도서 검색어").fill("검색할 제목");
  await lookup.getByRole("button", { name: "제목 검색" }).click();
  await lookup.getByRole("button", { name: "선택", exact: true }).click();
  await expect(page.getByLabel("책 제목")).toHaveValue(candidate.title);
  await expect(page.getByLabel("저자", { exact: true })).toHaveValue(
    candidate.author,
  );
  await expect(page.getByLabel("출판사", { exact: true })).toHaveValue(
    candidate.publisher,
  );
  await expect(
    page.getByRole("combobox", { name: "책 분야", exact: true }),
  ).toHaveValue("200");
  expect(await page.evaluate(() => (window as any).commands)).toEqual([]);
  await page.getByRole("button", { name: "저장하기", exact: true }).click();
  const saved = await page.evaluate(() => (window as any).commands[0]);
  expect(saved.type).toBe("editBook");
  expect(saved.payload).toMatchObject({
    id: book.id,
    expectedVersion: book.version,
    title: candidate.title,
    author: candidate.author,
    publisher: candidate.publisher,
    isbn: candidate.isbn,
    totalPages: candidate.totalPages,
    category: candidate.category,
    formats: ["pdf"],
    shelf: book.shelf,
    bookshelves: book.bookshelves,
    tags: book.tags,
    catalogSelection: {
      provider: candidate.provider,
      sourceUrl: candidate.sourceUrl,
    },
  });
  expect(queries).toEqual(["검색할 제목"]);
  expect(
    await page
      .getByRole("dialog")
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
});

test("incomplete lookup results preserve existing fields and cancel does not save", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await open(page, true, {
    ...candidate,
    author: "",
    publisher: "",
    isbn: "",
    coverUrl: "",
    totalPages: null,
    category: undefined,
  });
  await page.getByRole("button", { name: "제목 검색" }).click();
  await page.getByRole("button", { name: "선택", exact: true }).click();
  await expect(page.getByRole("textbox", { name: /^ISBN/ })).toHaveValue(
    book.isbn,
  );
  await expect(page.getByLabel("저자", { exact: true })).toHaveValue(
    book.author,
  );
  await expect(page.getByLabel("출판사", { exact: true })).toHaveValue(
    book.publisher,
  );
  await expect(page.getByLabel("전체 쪽수", { exact: true })).toHaveValue(
    String(book.totalPages),
  );
  await expect(
    page.getByRole("combobox", { name: "책 분야", exact: true }),
  ).toHaveValue(book.category);
  await expect(page.locator('input[name="coverUrl"]')).toHaveValue(
    book.coverUrl,
  );
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  expect(await page.evaluate(() => (window as any).commands)).toEqual([]);
});

test("barcode image lookup is available when editing and adding a book", async ({
  page,
}) => {
  await open(page);
  const L = [
    "0001101",
    "0011001",
    "0010011",
    "0111101",
    "0100011",
    "0110001",
    "0101111",
    "0111011",
    "0110111",
    "0001011",
  ];
  const parity = [
    "LLLLLL",
    "LLGLGG",
    "LLGGLG",
    "LLGGGL",
    "LGLLGG",
    "LGGLLG",
    "LGGGLL",
    "LGLGLG",
    "LGLGGL",
    "LGGLGL",
  ];
  const invert = (s: string) =>
    s.replace(/[01]/g, (c) => (c === "0" ? "1" : "0"));
  const digits = book.isbn.split("").map(Number);
  const bits =
    "101" +
    digits
      .slice(1, 7)
      .map((n, i) =>
        parity[digits[0]][i] === "L"
          ? L[n]
          : invert(L[n]).split("").reverse().join(""),
      )
      .join("") +
    "01010" +
    digits
      .slice(7)
      .map((n) => invert(L[n]))
      .join("") +
    "101";
  const bars = bits
    .split("")
    .map((b, i) =>
      b === "1"
        ? `<rect x="${(i + 15) * 3}" y="10" width="3" height="160"/>`
        : "",
    )
    .join("");
  await page.getByLabel("바코드 이미지 등록").setInputFiles({
    name: "isbn.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="375" height="180"><rect width="375" height="180" fill="white"/><g fill="black">${bars}</g></svg>`,
    ),
  });
  await expect(
    page.getByRole("button", { name: "선택", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("온라인 도서 검색어")).toHaveValue(book.isbn);
  await open(page, false);
  await expect(page.getByLabel("온라인 도서 검색어")).toHaveValue("");
  await expect(page.getByRole("button", { name: "바코드 스캔" })).toBeVisible();
  await expect(page.getByLabel("바코드 이미지 등록")).toBeVisible();
});
