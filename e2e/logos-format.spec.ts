import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { previewLibrary } from "../src/lib/preview-data";
test("ownership controls and search filters follow paper, Logos, ebook, PDF, unknown order", async ({
  page,
}) => {
  const bundle = (
    await build({
      stdin: {
        contents: `import{createRoot}from'react-dom/client';import{LibraryForm}from'./src/components/library-forms';import{AdvancedSearch}from'./src/components/advanced-search';import{LibraryApp}from'./src/components/library-app';const root=createRoot(document.getElementById('root'));window.showSearch=()=>root.render(<AdvancedSearch mode="book" library={window.fixture} preview onOpen={()=>{}}/>);window.showApp=()=>root.render(<LibraryApp initial={window.fixture} today="2026-11-11" preview/>);root.render(<LibraryForm editor={{kind:'book'}} library={window.fixture} today="2026-11-11" preview={false} onClose={()=>{}} onSave={async c=>{window.saved=c}}/>);`,
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
  await page.route("https://library.test/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<html><body><div id="root"></div></body></html>',
    }),
  );
  await page.goto("https://library.test");
  await page.route("https://library.test/api/**", (route) =>
    route.fulfill({ json: { items: [], total: 0, topics: [] } }),
  );
  await page.evaluate(
    (value) => {
      (window as any).fixture = value;
    },
    {
      ...previewLibrary,
      books: previewLibrary.books.slice(0, 3).map((b, i) => ({
        ...b,
        formats: [["paper"], ["logos"], ["ebook"]][i],
      })),
      notes: [],
      cycles: [],
    },
  );
  await page.addScriptTag({ content: bundle });
  const formats = page.getByRole("group", { name: "소장 형태" });
  await expect(formats.getByRole("checkbox")).toHaveCount(5);
  expect(
    await formats
      .getByRole("checkbox")
      .evaluateAll((elements) =>
        elements.map((e) => e.closest("label")?.textContent?.trim()),
      ),
  ).toEqual(["종이책", "로고스", "전자책", "PDF", "형식 확인 필요"]);
  await formats.getByRole("checkbox", { name: "로고스", exact: true }).check();
  await expect(
    formats.getByRole("checkbox", { name: "전자책", exact: true }),
  ).not.toBeChecked();
  await page.getByLabel("책 제목 *", { exact: true }).fill("새 로고스 책");
  await page.getByRole("button", { name: "저장하기", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).saved?.payload.formats))
    .toEqual(["paper", "logos"]);
  await page.evaluate(() => (window as any).showSearch());
  const filter = page.getByLabel("소장·독서 상태");
  expect((await filter.locator("option").allTextContents()).slice(3)).toEqual([
    "종이책",
    "로고스",
    "전자책",
    "PDF",
    "형식 확인 필요",
  ]);
  await filter.selectOption("logos");
  await expect(filter).toHaveValue("logos");
  await page.evaluate(() => (window as any).showApp());
  await expect(
    page.getByText(
      "종이책 1 · 로고스 1 · 전자책 1 · PDF 0 · 형식 확인 필요 0",
      { exact: true },
    ),
  ).toBeVisible();
});
