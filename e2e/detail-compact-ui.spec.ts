import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { previewLibrary } from "../src/lib/preview-data";
let bundle: string;
const book = {
  ...previewLibrary.books[0],
  title: "상세 화면 확인 도서",
  enrichment: {
    catalogSelection: {
      provider: "yes24",
      sourceUrl: "https://www.yes24.com/product/goods/123",
      description: "확인용 책 소개",
    },
  },
};
const note = {
  ...previewLibrary.notes[0],
  bookId: book.id,
  title: "접힌 기록 제목",
  content: "펼쳤을 때만 보여야 하는 내용",
};
test.beforeAll(async () => {
  bundle = (
    await build({
      stdin: {
        contents: `import {createRoot} from 'react-dom/client';import {LibraryApp} from './src/components/library-app';import {BookRecords} from './src/components/book-records';const v=window.fixture;createRoot(document.getElementById('root')).render(v.records?<BookRecords bookId={v.book.id} revision={0} onNote={id=>window.openedNote=id} onCycle={()=>{}}/>:<LibraryApp initial={v.library} today="2026-11-15" preview={v.preview} initialView="books"/>);`,
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
for (const width of [390, 1280]) {
  test(`detail order, compact headers and collapsed notes at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route("https://compact.test/**", (r) =>
      r.request().url() === "https://compact.test/"
        ? r.fulfill({
            contentType: "text/html",
            body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div>',
          })
        : r.fulfill({ json: { items: [], total: 0 } }),
    );
    await page.goto("https://compact.test/");
    await page.evaluate((v) => ((window as any).fixture = v), {
      library: {
        books: [book],
        notes: [note],
        shelves: [],
        cycles: [
          {
            ...previewLibrary.cycles[0],
            bookId: book.id,
            status: "completed",
            startedOn: null,
            completedOn: null,
          },
        ],
      },
      preview: false,
    });
    await page.addStyleTag({ path: "src/app/globals.css" });
    await page.addScriptTag({ content: bundle });
    await page.locator(".shelf-card").click();
    const dialog = page.getByRole("dialog", { name: "상세 정보", exact: true });
    await expect(dialog).toBeVisible();
    const order = await dialog.evaluate((el) =>
      [
        ".detail-actions",
        ".shelf-picker",
        ".catalog-credit",
        ".unified-book-information",
        ".book-evidence",
      ].map((sel) =>
        Array.from(el.querySelectorAll("*")).indexOf(el.querySelector(sel)!),
      ),
    );
    expect(
      order.every((n, i) => n >= 0 && (i === 0 || n > order[i - 1])),
    ).toBeTruthy();
    await expect(
      dialog.getByRole("heading", { name: "독서이력 1개", exact: true }),
    ).toBeVisible();
    await expect(dialog.getByText(/날짜 미입력 완독/)).toBeVisible();
    await expect(
      dialog.getByRole("heading", { name: "기록 1개", exact: true }),
    ).toBeVisible();
    await expect(dialog.getByText("표시 개수", { exact: true })).toHaveCount(0);
    const header = dialog.locator(".book-records-header").last();
    const positions = await header.evaluate((el) => ({
      h: el.querySelector("h3")!.getBoundingClientRect().right,
      s: el.querySelector("select")!.getBoundingClientRect().left,
    }));
    expect(positions.s).toBeGreaterThan(positions.h);
    const record = dialog.locator(".book-record-details");
    await expect(record.locator("summary")).toHaveText(note.title);
    await expect(
      record.getByText(note.content, { exact: true }),
    ).not.toBeVisible();
    await dialog.screenshot({
      path: test.info().outputPath(`detail-${width}.png`),
    });
    await record.locator("summary").click();
    await expect(record.getByText(note.content, { exact: true })).toBeVisible();
    await record.getByRole("button", { name: note.title, exact: true }).click();
    await expect(
      page.getByRole("textbox", { name: "제목", exact: true }),
    ).toHaveValue(note.title);
  });
}
test("remote records retain page size and note navigation inside expansion", async ({
  page,
}) => {
  await page.route("https://compact.test/**", (r) => {
    const url = new URL(r.request().url());
    return url.pathname === "/"
      ? r.fulfill({ contentType: "text/html", body: '<div id="root"></div>' })
      : r.fulfill({
          json: {
            items: url.pathname === "/api/notes" ? [note] : [],
            total: url.pathname === "/api/notes" ? 1 : 0,
          },
        });
  });
  await page.goto("https://compact.test/");
  await page.evaluate((v) => ((window as any).fixture = v), {
    records: true,
    book,
  });
  await page.addScriptTag({ content: bundle });
  await expect(
    page.getByRole("heading", { name: "기록 1개", exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("책별 기록 표시 개수", { exact: true })
    .selectOption("10");
  const record = page.locator(".book-record-details");
  await expect(
    record.getByText(note.content, { exact: true }),
  ).not.toBeVisible();
  await record.locator("summary").click();
  await record.getByRole("button", { name: "기록 열기" }).click();
  expect(await page.evaluate(() => (window as any).openedNote)).toBe(note.id);
});
