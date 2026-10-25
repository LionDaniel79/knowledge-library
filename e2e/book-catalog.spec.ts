import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { previewLibrary } from "../src/lib/preview-data";
const first = {
  ...previewLibrary.books[0],
  id: "00000000-0000-4000-a000-000000000001",
  title: "첫 페이지 책",
};
const distant = {
  ...first,
  id: "00000000-0000-4000-a000-000000000099",
  title: "멀리 있는 정서 책",
  publisher: "검증된 출판사",
  sourceData: {
    app: "iReadItNow HD",
    libraryId: "original",
    recordId: "99",
    raw: { memo: "원자료" },
  },
};
test.use({ viewport: { width: 390, height: 844 } });
let bundle: string;
test.beforeAll(async () => {
  bundle = (
    await build({
      stdin: {
        contents: `import {createRoot} from 'react-dom/client';import {LibraryApp} from './src/components/library-app';createRoot(document.getElementById('root')).render(<LibraryApp initial={window.fixture} today="2026-10-14"/>);`,
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
test("server catalog searches beyond loaded books, ignores late results and opens full details for editing and note selection", async ({
  page,
}) => {
  const fixture = {
    books: [first],
    cycles: [],
    notes: [],
    shelves: [],
    catalog: {
      total: 10994,
      formatCounts: { paper: 1000, pdf: 9309, ebook: 685, unknown: 0 },
      categoryCounts: { "100": 100 },
      firstPage: { items: [first], total: 10994, nextCursor: "page-2" },
    },
  };
  let noteBody: any,
    releaseSlow: () => void = () => {},
    slowStarted: () => void = () => {};
  const slowSeen = new Promise<void>((r) => {
      slowStarted = r;
    }),
    slowWait = new Promise<void>((r) => {
      releaseSlow = r;
    });
  await page.route("https://library.test/api/books?*", async (route) => {
    const p = new URL(route.request().url()).searchParams;
    if (p.get("q") === "느린 검색") {
      slowStarted();
      await slowWait;
      await route
        .fulfill({
          json: {
            items: [{ ...distant, title: "늦은 결과" }],
            total: 1,
            nextCursor: null,
          },
        })
        .catch(() => {});
      return;
    }
    const found = p.get("q")?.includes("정서") || Number(p.get("offset")) > 0;
    await route.fulfill({
      json: found
        ? { items: [distant], total: p.get("q") ? 1 : 10994, nextCursor: null }
        : { items: [first], total: 10994, nextCursor: "page-2" },
    });
  });
  await page.route("https://library.test/api/books/" + distant.id, (r) =>
    r.fulfill({ json: distant }),
  );
  await page.route("https://library.test/api/curation?*", (r) =>
    r.fulfill({
      json: { items: [], references: [], history: [], version: "1" },
    }),
  );
  await page.route("https://library.test/api/library", (r) => {
    if (r.request().method() === "POST") {
      noteBody = r.request().postDataJSON();
      return r.fulfill({ json: { id: "note", version: 1 } });
    }
    return r.fulfill({ json: fixture });
  });
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
  await page.getByRole("button", { name: "메뉴 열기", exact: true }).click();
  await page.getByRole("button", { name: /소장 도서/ }).click();
  await page
    .getByRole("navigation", { name: "소장 도서 페이지", exact: true })
    .getByRole("button", { name: "다음", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: /멀리 있는 정서 책/ }).first(),
  ).toBeVisible();
  const search = page.getByRole("searchbox", {
    name: "소장 도서 검색",
    exact: true,
  });
  await search.fill("느린 검색");
  await slowSeen;
  await search.fill("정서");
  await expect(page.locator(".shelf-card")).toHaveCount(1);
  await expect(page.locator(".shelf-card")).toContainText("멀리 있는 정서 책");
  releaseSlow();
  await expect(page.getByText("늦은 결과", { exact: true })).toHaveCount(0);
  await page.locator(".shelf-card").click();
  await expect(page.getByRole("dialog")).toContainText("검증된 출판사");
  await page.getByRole("button", { name: "수정", exact: true }).click();
  await expect(page.getByLabel(/책 제목/)).toHaveValue("멀리 있는 정서 책");
  await page.getByRole("button", { name: "닫기", exact: true }).last().click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "기록", exact: true })
    .click();
  await page.getByLabel("연결할 책 검색", { exact: true }).fill("정서");
  await expect(
    page
      .getByRole("combobox", { name: "연결할 책", exact: true })
      .locator("option"),
  ).toContainText(["책과 연결하지 않은 생각", "멀리 있는 정서 책"]);
  await page
    .getByRole("combobox", { name: "연결할 책", exact: true })
    .selectOption(distant.id);
  await page.getByLabel("제목", { exact: true }).fill("내 정서 기록");
  await page.getByLabel("내용", { exact: true }).fill("직접 쓴 생각");
  await page.getByRole("button", { name: "저장하기", exact: true }).click();
  expect(noteBody.payload.bookId).toBe(distant.id);
});
