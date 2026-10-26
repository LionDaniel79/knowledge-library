import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { previewLibrary } from "../src/lib/preview-data";
let bundle: string;
test.beforeAll(async () => {
  bundle = (
    await build({
      stdin: {
        contents: `import{createRoot}from'react-dom/client';import{LibraryApp}from'./src/components/library-app';import{IntegratedSearch}from'./src/components/integrated-search';import{BookPicker}from'./src/components/book-picker';import{FacetPicker}from'./src/components/whiteboard/facet-picker';import{NoteTagFilter}from'./src/components/note-tag-filter';const options=[{value:'a',label:'인간 본성의 4중 상태'},{value:'b',label:'인간의 역사'}];createRoot(document.getElementById('root')).render(window.mode==='library'?<LibraryApp initial={window.fixture} today="2026-10-27"/>:window.mode==='integrated'?<IntegratedSearch library={window.fixture} onOpen={()=>{}}/>:window.mode==='picker'?<form><BookPicker library={window.fixture}/></form>:<><FacetPicker label="주제" values={[]} options={options} onChange={()=>{}}/><NoteTagFilter tags={options.map(o=>o.label)} value="all" onChange={()=>{}} onUpdated={async()=>{}} preview searchable/></>);`,
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
async function mount(page: Page, mode: string) {
  const books = ["인간 본성의 4중 상태", "인간의 역사"].map((title, i) => ({
    ...previewLibrary.books[0],
    id: crypto.randomUUID(),
    title,
    author: "토머스 보스턴",
    tags: [],
    bookshelves: [],
    isbn: String(i),
  }));
  const notes = books.map((b, i) => ({
    ...previewLibrary.notes[0],
    id: crypto.randomUUID(),
    bookId: b.id,
    title: i ? "다른 인간 기록" : "인간 본성의 기록",
    content: i ? "인간에 관한 다른 생각" : "인간의 본성과 상태를 생각한다",
    tags: [],
  }));
  const fixture = {
    ...previewLibrary,
    books,
    notes,
    cycles: [],
    catalog: undefined,
  };
  await page.route("https://library.test/api/**", (r) =>
    r.fulfill({
      json: {
        items: [],
        total: 0,
        topics: [],
        memberships: [],
        connections: [],
      },
    }),
  );
  await page.route("https://library.test/", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html lang="ko"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>',
    }),
  );
  await page.goto("https://library.test/");
  await page.evaluate((value) => Object.assign(window, value), {
    fixture,
    mode,
  });
  await page.addStyleTag({ path: "src/app/globals.css" });
  await page.addScriptTag({ content: bundle });
}
test("owned books find nonadjacent words and reject a book missing one word", async ({
  page,
}) => {
  await mount(page, "library");
  await page.getByRole("button", { name: "메뉴 열기", exact: true }).click();
  await page.getByRole("button", { name: /^소장 도서/ }).click();
  await page
    .getByRole("searchbox", { name: "소장 도서 검색" })
    .fill("인간 상태");
  await expect(page.locator(".shelf-card")).toHaveCount(1);
  await expect(page.locator(".shelf-card")).toContainText(
    "인간 본성의 4중 상태",
  );
  await page
    .getByRole("searchbox", { name: "소장 도서 검색" })
    .fill("상태 인간");
  await expect(page.locator(".shelf-card")).toHaveCount(1);
});
test("integrated search shows both books and memos for separated words", async ({
  page,
}) => {
  await mount(page, "integrated");
  await page.getByRole("searchbox", { name: "통합 검색어" }).fill("상태 인간");
  await expect(page.locator(".shelf-card")).toHaveCount(1);
  await expect(page.locator(".note-card")).toHaveCount(1);
});
test("book picker supports separated words when linking a memo", async ({
  page,
}) => {
  await mount(page, "picker");
  await page
    .getByPlaceholder("제목·저자·ISBN으로 전체 서재 검색")
    .fill("인간 상태");
  await expect(
    page.getByRole("option", { name: /인간 본성의 4중 상태/ }),
  ).toHaveCount(1);
  await expect(page.getByRole("option", { name: /인간의 역사/ })).toHaveCount(
    0,
  );
});
test("topic and tag dropdowns use the same all-words search", async ({
  page,
}) => {
  await mount(page, "facet");
  await page.getByRole("button", { name: "주제 선택", exact: true }).click();
  await page
    .getByRole("textbox", { name: "주제 검색", exact: true })
    .fill("상태 인간");
  await expect(
    page.getByRole("option", { name: "인간 본성의 4중 상태", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("option", { name: "인간의 역사", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "태그 선택", exact: true }).click();
  await page
    .getByRole("searchbox", { name: "태그 검색", exact: true })
    .fill("상태 인간");
  await page.locator(".tag-filter details").dispatchEvent("toggle");
  await expect(
    page.getByRole("searchbox", { name: "태그 검색", exact: true }),
  ).toHaveValue("상태 인간");
  await expect(page.locator(".tag-option")).toHaveCount(1);
  await expect(page.locator(".tag-option")).toContainText(
    "인간 본성의 4중 상태",
  );
});
