import { openMyNotes } from "./helpers/notes-navigation";
import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { previewLibrary } from "../src/lib/preview-data";
const books = Array.from({ length: 65 }, (_, i) => ({
  ...previewLibrary.books[0],
  id: `00000000-0000-4000-a000-${String(i + 1).padStart(12, "0")}`,
  title: `도서 ${i + 1}`,
}));
const notes = Array.from({ length: 65 }, (_, i) => ({
  id: `10000000-0000-4000-a000-${String(i + 1).padStart(12, "0")}`,
  title: `기록 ${i + 1}`,
  content: `생각 ${i + 1}`,
  kind: "thought",
  tags: [],
  bookId: null,
  version: 1,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
}));
const fixture = {
  books: [],
  notes: notes.slice(0, 24),
  cycles: [],
  shelves: [],
  catalog: {
    total: 65,
    formatCounts: { paper: 65, pdf: 0, ebook: 0, unknown: 0 },
    categoryCounts: {},
    firstPage: { items: books.slice(0, 24), total: 65, nextCursor: "old" },
  },
};
let bundle: string;
test.beforeAll(async () => {
  bundle = (
    await build({
      stdin: {
        contents: `import {createRoot} from 'react-dom/client';import {LibraryApp} from './src/components/library-app';createRoot(document.getElementById('root')).render(<LibraryApp initial={window.fixture} today="2026-10-17"/>);`,
        resolveDir: process.cwd(),
        loader: "tsx",
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
async function setup(page: Page) {
  await page.route("https://library.test/api/books?*", (r) => {
    const p = new URL(r.request().url()).searchParams,
      offset = Number(p.get("offset")),
      size = Number(p.get("limit")) || 24;
    const found = p.get("q")
      ? books.filter((b) => b.title.includes(p.get("q")!))
      : books;
    return r.fulfill({
      json: {
        items: found.slice(offset, offset + size),
        total: found.length,
        nextCursor: null,
      },
    });
  });
  await page.route("https://library.test/api/notes?*", (r) => {
    const p = new URL(r.request().url()).searchParams,
      offset = Number(p.get("offset")),
      size = Number(p.get("limit")) || 24;
    return r.fulfill({
      json: {
        items: notes.slice(offset, offset + size),
        total: notes.length,
        nextOffset: null,
      },
    });
  });
  await page.route("https://library.test/", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: '<html lang="ko"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>',
    }),
  );
  await mount(page);
}
async function mount(page: Page) {
  await page.goto("https://library.test/");
  await page.evaluate((v) => {
    (window as any).fixture = v;
  }, fixture);
  await page.addStyleTag({ path: "src/app/globals.css" });
  await page.addScriptTag({ content: bundle });
}
async function navigate(page: Page, name: string) {
  await page.getByRole("button", { name: "메뉴 열기", exact: true }).click();
  await page
    .getByRole("dialog", { name: "서재 메뉴" })
    .getByRole("button", { name: new RegExp("^" + name + "(?: \\d+)?$") })
    .click();
}

test("books and notes replace pages, keep per-device sizes and reset filters without horizontal overflow", async ({
  page,
  browser,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await navigate(page, "소장 도서");
  await expect(page.locator(".shelf-card")).toHaveCount(30);
  const size = page.getByRole("combobox", {
    name: "소장 도서 표시 개수",
    exact: true,
  });
  await size.selectOption("10");
  await expect(page.locator(".shelf-card")).toHaveCount(10);
  const nav = page.getByRole("navigation", {
    name: "소장 도서 페이지",
    exact: true,
  });
  await nav.getByRole("button", { name: "다음", exact: true }).click();
  await expect(page.locator(".shelf-card").first()).toContainText("도서 11");
  await expect(page.locator(".shelf-card")).toHaveCount(10);
  await page.getByLabel("도서 정렬").selectOption("title");
  await expect(page.locator(".shelf-card").first()).toHaveText(/도서 1\D/);
  await page.getByLabel("도서 정렬").selectOption("newest");
  await expect(page.locator(".shelf-card").first()).toHaveText(/도서 1\D/);
  await nav.getByRole("button", { name: "마지막 페이지", exact: true }).click();
  await expect(page.locator(".shelf-card")).toHaveCount(5);
  await expect(
    nav.getByRole("button", { name: "다음", exact: true }),
  ).toBeDisabled();
  await size.selectOption("50");
  await expect(page.locator(".shelf-card")).toHaveCount(50);
  await expect(page.locator(".shelf-card").first()).toContainText("도서 1");
  await size.selectOption("10");
  await openMyNotes(page, { books, notes });
  await page
    .getByRole("combobox", { name: "내 기록 표시 개수", exact: true })
    .selectOption("15");
  await expect(page.locator(".thought-card")).toHaveCount(15);
  const noteNav = page.getByRole("navigation", {
    name: "내 기록 페이지",
    exact: true,
  });
  await noteNav.getByRole("button", { name: "2페이지", exact: true }).click();
  await expect(page.locator(".thought-card").first()).toContainText("기록 16");
  await mount(page);
  await navigate(page, "소장 도서");
  await expect(size).toHaveValue("10");
  await expect(page.locator(".shelf-card")).toHaveCount(10);
  await openMyNotes(page, { books, notes });
  await expect(
    page.getByRole("combobox", { name: "내 기록 표시 개수", exact: true }),
  ).toHaveValue("15");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  const other = await browser.newContext();
  try {
    const second = await other.newPage();
    await setup(second);
    await navigate(second, "소장 도서");
    await expect(
      second.getByRole("combobox", {
        name: "소장 도서 표시 개수",
        exact: true,
      }),
    ).toHaveValue("30");
    await expect(second.locator(".shelf-card")).toHaveCount(30);
  } finally {
    await other.close();
  }
});
