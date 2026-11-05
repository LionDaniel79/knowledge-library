import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { previewLibrary } from "../src/lib/preview-data";
test.use({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
test("excluded materials are searchable and can be restored with a stable retry; normal library updates on mobile", async ({
  page,
}) => {
  const active = previewLibrary.books[0],
    archived = {
      ...active,
      id: "11111111-1111-4111-a111-111111111111",
      title: "잘못 분류된 책",
    };
  let restored = false;
  const posts: any[] = [];
  const library = () => ({
    books: restored ? [active, archived] : [active],
    notes: [],
    cycles: [],
    catalog: {
      total: restored ? 2 : 1,
      formatCounts: { paper: 1, pdf: restored ? 1 : 0 },
      categoryCounts: {},
      firstPage: {
        items: restored ? [active, archived] : [active],
        total: restored ? 2 : 1,
        nextCursor: null,
      },
    },
  });
  await page.route("https://excluded.test/api/books?*", (r) =>
    r.fulfill({
      json: {
        items: restored ? [active, archived] : [active],
        total: restored ? 2 : 1,
        nextCursor: null,
      },
    }),
  );
  await page.route("https://excluded.test/api/library", (r) =>
    r.fulfill({ json: library() }),
  );
  await page.route("https://excluded.test/api/book-exclusions**", async (r) => {
    if (r.request().method() === "POST") {
      posts.push(r.request().postDataJSON());
      restored = true;
      if (posts.length === 1) return r.abort();
      return r.fulfill({
        json: { restored: true, id: archived.id, version: 2 },
      });
    }
    return r.fulfill({
      json: {
        total: restored ? 0 : 1,
        items: restored
          ? []
          : [
              {
                id: archived.id,
                title: archived.title,
                author: "저자",
                kind: "paper",
                reason: "논문·간행물 일괄 제외",
                relativePath: "논문/잘못.pdf",
                excludedAt: "2026-10-17T00:00:00Z",
                version: 1,
              },
            ],
      },
    });
  });
  await page.route("https://excluded.test/", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: '<html lang="ko"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>',
    }),
  );
  await page.goto("https://excluded.test/");
  await page.evaluate((v) => {
    (window as any).fixture = v;
  }, library());
  await page.addStyleTag({ path: "src/app/globals.css" });
  const bundle = (
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
  await page.addScriptTag({ content: bundle });
  await page.getByRole("button", { name: "메뉴 열기", exact: true }).tap();
  await page.getByRole("button", { name: /^소장 도서/ }).tap();
  await expect(
    page.getByRole("button", { name: "삭제·제외한 자료", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "삭제·제외한 자료", exact: true })
    .tap();
  const dialog = page.getByRole("dialog", {
    name: "삭제·제외한 자료",
    exact: true,
  });
  await expect(
    dialog.getByRole("heading", { name: archived.title, exact: true }),
  ).toBeVisible();
  const bounds = await dialog.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  expect(await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(
    true,
  );
  await dialog
    .getByRole("searchbox", { name: "삭제·제외한 자료 검색" })
    .fill("잘못");
  await expect(
    dialog.getByRole("heading", { name: archived.title }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "복원", exact: true }).tap();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await dialog.getByRole("button", { name: "복원", exact: true }).tap();
  await expect(dialog.getByRole("status")).toContainText("복원했습니다");
  expect(posts).toHaveLength(2);
  expect(posts[1]).toEqual(posts[0]);
  expect(posts[0]).toMatchObject({ id: archived.id, expectedVersion: 1 });
  await dialog.getByRole("button", { name: "닫기", exact: true }).tap();
  await expect(
    page.getByRole("button", { name: new RegExp(archived.title) }),
  ).toBeVisible();
});
