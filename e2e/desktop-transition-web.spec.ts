import { test, expect } from "@playwright/test";
import { build } from "esbuild";

let bundle: string;
test.beforeAll(async () => {
  bundle = (
    await build({
      stdin: {
        contents: `import{createRoot}from'react-dom/client';import{LibraryApp}from'./src/components/library-app';import{previewLibrary}from'./src/lib/preview-data';const book={...previewLibrary.books[0],title:'PDF 서지 검수',formats:['pdf'],shelf:'이전 보관 위치',sourceData:{app:'Local PDF',libraryId:'test',recordId:'10000000-0000-4000-8000-000000000001',raw:{}},enrichment:{desktopPdf:{resourceId:'20000000-0000-4000-8000-000000000001',locations:[{rootKey:'christian',relativePath:'분류/도서.pdf'},{rootKey:'general',relativePath:'사본.pdf'}],lastCheckedAt:'2026-11-04T01:00:00Z'}}};createRoot(document.getElementById('root')).render(<LibraryApp initial={{books:[book],notes:[],cycles:[]}} today='2026-11-04' ownerId='transition-fixture'/>);`,
        resolveDir: process.cwd(),
        loader: "tsx",
      },
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
    })
  ).outputFiles[0].text;
});

test("web library keeps PDF bibliography and locations without the retired PC original-search features", async ({
  page,
}) => {
  const calls: string[] = [];
  await page.route("https://transition.test/**", (r) => {
    const path = new URL(r.request().url()).pathname;
    if (path === "/")
      return r.fulfill({
        contentType: "text/html",
        body: '<div id="root"></div>',
      });
    calls.push(path);
    return r.fulfill({ status: 503, json: { error: "isolated fixture" } });
  });
  await page.goto("https://transition.test/");
  await page.addScriptTag({ content: bundle });
  await page.getByRole("button", { name: "메뉴 열기", exact: true }).click();
  await expect(
    page
      .getByRole("navigation", { name: "주 메뉴" })
      .getByRole("button", { name: "PDF 원문 검색", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("navigation", { name: "주 메뉴" })
    .getByRole("button", { name: /^소장 도서/ })
    .click();
  await page.getByRole("button", { name: /PDF 서지 검수/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "PDF 서지 검수" }),
  ).toBeVisible();
  await expect(
    dialog.getByText("기독도서 / 분류/도서.pdf", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText("일반도서 / 사본.pdf", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("link", { name: "PDF 원문 열기", exact: true }),
  ).toHaveCount(0);
  expect(calls.filter((path) => path.startsWith("/api/pdf"))).toEqual([]);
});
