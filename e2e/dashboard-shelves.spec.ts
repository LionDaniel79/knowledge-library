import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { previewLibrary } from "../src/lib/preview-data";
const books = Array.from({ length: 34 }, (_, i) => ({
  ...previewLibrary.books[0],
  id: `book-${i}`,
  title: `대기 도서 ${String(i).padStart(2, "0")}`,
  bookshelves: i < 32 ? ["책 대기열"] : ["연구 서재"],
  createdAt: new Date(Date.UTC(2026, 9, 31) - i * 86400000).toISOString(),
}));
let bundle: string;
test.beforeAll(async () => {
  bundle = (
    await build({
      stdin: {
        contents: `import {createRoot} from 'react-dom/client';import {LibraryApp} from './src/components/library-app';createRoot(document.getElementById('root')).render(<LibraryApp initial={window.fixture} today="2026-11-11" preview/>);`,
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
async function mount(page: Page, fixture: unknown) {
  await page.route("https://library.test/", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: '<html lang="ko"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>',
    }),
  );
  await page.goto("https://library.test/");
  await page.evaluate((v) => {
    (window as any).fixture = v;
  }, fixture);
  await page.addStyleTag({ path: "src/app/globals.css" });
  await page.addScriptTag({ content: bundle });
}
for (const width of [390, 1280]) {
  test(`home queue pages, opens details, shelf menu reuses catalog and owned card resets all filters (${width}px)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await mount(page, {
      books,
      cycles: [],
      notes: [],
      shelves: ["연구 서재", "빈 서재"],
    });
    const queue = page.getByRole("region", { name: "책 대기열", exact: true });
    await expect(queue.locator(".shelf-card")).toHaveCount(30);
    await queue
      .getByRole("navigation", { name: "책 대기열 페이지" })
      .getByRole("button", { name: "다음", exact: true })
      .click();
    await expect(queue.locator(".shelf-card")).toHaveCount(2);
    await queue.locator(".shelf-card").first().click();
    await expect(page.getByRole("dialog")).toContainText("대기 도서 30");
    await page
      .getByRole("button", { name: "닫기", exact: true })
      .last()
      .click();
    await page.getByRole("button", { name: "메뉴 열기", exact: true }).click();
    await page
      .getByRole("button", { name: "서재별 보기", exact: true })
      .click();
    await page
      .getByRole("combobox", { name: "책장별 소장 도서" })
      .selectOption("연구 서재");
    await expect(page.locator(".shelf-card")).toHaveCount(2);
    await page
      .getByRole("combobox", { name: "책장별 소장 도서" })
      .selectOption("빈 서재");
    await expect(
      page.getByRole("heading", { name: "이 서재에 담긴 책이 없습니다" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "메뉴 열기", exact: true }).click();
    await page.getByRole("button", { name: "나의 서재", exact: true }).click();
    await page.getByRole("button", { name: "소장한 책", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("heading", { name: "소장 도서", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("combobox", { name: "책장별 소장 도서" }),
    ).toHaveValue("all");
    await expect(page.locator(".shelf-card")).toHaveCount(30);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
  });
}
test("recent completed home books include today and day30, deduplicate rereads, order latest first", async ({
  page,
}) => {
  const cycle = (id: string, bookId: string, date: string | null) => ({
    ...previewLibrary.cycles[0],
    id,
    bookId,
    status: "completed",
    completedOn: date,
  });
  await mount(page, {
    books,
    notes: [],
    shelves: [],
    cycles: [
      cycle("a", "book-0", "2026-11-11"),
      cycle("b", "book-0", "2026-11-01"),
      cycle("c", "book-1", "2026-10-13"),
      cycle("d", "book-2", "2026-10-12"),
      cycle("e", "book-3", "2026-11-12"),
      cycle("f", "book-4", null),
    ],
  });
  const recent = page.getByRole("region", {
    name: "최근 읽은 책",
    exact: true,
  });
  await expect(recent.locator(".shelf-card")).toHaveCount(2);
  await expect(recent.locator(".shelf-card").first()).toContainText(
    "대기 도서 00",
  );
  await expect(recent.locator(".shelf-card").last()).toContainText(
    "대기 도서 01",
  );
  await expect(recent.locator("time")).toHaveText(["2026-11-11", "2026-10-13"]);
  await recent.locator(".shelf-card").last().click();
  await expect(page.getByRole("dialog")).toContainText("대기 도서 01");
});

test("remote home requests bounded queue and recent pages with hydrated detail links", async ({
  page,
}) => {
  const requests: URL[] = [];
  await page.route("https://library.test/api/books?*", (r) => {
    const url = new URL(r.request().url());
    requests.push(url);
    return r.fulfill({
      json: { items: books.slice(0, 2), total: 2, nextCursor: null },
    });
  });
  await page.route("https://library.test/api/reading?*", (r) => {
    const url = new URL(r.request().url());
    requests.push(url);
    return r.fulfill({
      json: {
        items: [
          {
            ...previewLibrary.cycles[0],
            id: "recent",
            bookId: books[33].id,
            status: "completed",
            completedOn: "2026-11-11",
          },
        ],
        books: [books[33]],
        total: 1,
        nextOffset: null,
      },
    });
  });
  await page.route("https://library.test/api/books/" + books[33].id, (r) =>
    r.fulfill({ json: books[33] }),
  );
  await mount(page, {
    books: [],
    notes: [],
    cycles: [],
    shelves: [],
    catalog: {
      total: 10000,
      formatCounts: {},
      categoryCounts: {},
      firstPage: { items: [], total: 10000, nextCursor: null },
    },
  });
  const recent = page.getByRole("region", {
    name: "최근 읽은 책",
    exact: true,
  });
  await expect(recent.locator(".shelf-card")).toHaveCount(1);
  await recent.locator(".shelf-card").click();
  await expect(page.getByRole("dialog")).toContainText("대기 도서 33");
  expect(requests).toHaveLength(2);
  expect(
    requests
      .find((u) => u.pathname === "/api/books")
      ?.searchParams.get("shelf"),
  ).toBe("책 대기열");
  expect(
    requests
      .find((u) => u.pathname === "/api/reading")
      ?.searchParams.get("recentThrough"),
  ).toBe("2026-11-11");
  for (const url of requests) {
    expect(Number(url.searchParams.get("limit"))).toBe(30);
    expect(url.searchParams.get("offset")).toBe("0");
  }
});
