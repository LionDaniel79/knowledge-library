import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";

let bundle: string;
const quote =
  '상담 관계에서 은혜를 배우고 상담 관계를 다시 읽는다. <img src=x onerror="window.pdfInjected=true">';
const documentId = "00000000-0000-4000-a000-000000000001";
test.beforeAll(async () => {
  bundle = (
    await build({
      stdin: {
        contents: `import {createRoot} from 'react-dom/client';import {PdfLibraryPanel} from './src/components/pdf-library-panel';createRoot(document.getElementById('root')).render(<PdfLibraryPanel documentId={window.bookOnly ? '${documentId}' : undefined} onSaved={async()=>{}}/>);`,
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
async function mount(page: Page, bookOnly: boolean, excerpt = quote) {
  await page.route("https://library.test/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/")
      return route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><html lang="ko"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>',
      });
    if (url.pathname === "/api/pdf")
      return route.fulfill({
        json: {
          documents: [],
          total: 0,
          hits: url.searchParams.get("q")
            ? [
                {
                  documentId,
                  bookId: "book",
                  title: "원문 검색 결과",
                  pageNumber: 7,
                  quote: excerpt,
                  signature: "1:2",
                  extractionMethod: "text",
                },
              ]
            : [],
        },
      });
    return route.fulfill({ json: { available: false, local: false } });
  });
  await page.goto("https://library.test/");
  await page.evaluate(
    (value) => Object.assign(window, { bookOnly: value }),
    bookOnly,
  );
  await page.addStyleTag({ path: "src/app/globals.css" });
  await page.addScriptTag({ content: bundle });
}
for (const bookOnly of [false, true]) {
  test(`bolds phrases and words safely in ${bookOnly ? "book detail" : "all-PDF"} results, preserving the source citation`, async ({
    page,
  }) => {
    await mount(page, bookOnly);
    if (!bookOnly)
      await page.getByLabel("PDF 검색 범위").selectOption("search");
    await page
      .getByLabel("PDF 검색어", { exact: true })
      .fill("“상담 관계” 은혜");
    await page.getByRole("button", { name: "검색", exact: true }).click();
    const excerpt = page.locator(".pdf-results blockquote");
    await expect(excerpt).toHaveText(quote);
    await expect(excerpt.locator("strong")).toHaveText([
      "상담 관계",
      "은혜",
      "상담 관계",
    ]);
    expect(
      await excerpt
        .locator("strong")
        .first()
        .evaluate((element) => Number(getComputedStyle(element).fontWeight)),
    ).toBeGreaterThanOrEqual(700);
    await expect(excerpt.locator("img")).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as any).pdfInjected),
    ).toBeUndefined();
    await page.getByLabel("PDF 검색어", { exact: true }).fill("다른 단어");
    await expect(excerpt.locator("strong")).toHaveText([
      "상담 관계",
      "은혜",
      "상담 관계",
    ]);
    await expect(
      page.getByRole("link", { name: "원문 페이지 열기" }),
    ).toHaveAttribute("href", `/reader/${documentId}?page=7&signature=1%3A2`);
    const saved = page.waitForRequest((request) =>
      request.url().endsWith("/api/pdf/citation"),
    );
    await page.getByRole("button", { name: "하이라이트로 저장" }).click();
    expect((await saved).postDataJSON().quote).toBe(quote);
  });
}
test("highlights a repeated overlapping phrase once per occurrence and keeps a changed input separate", async ({
  page,
}) => {
  await mount(page, true);
  await page.getByLabel("PDF 검색어", { exact: true }).fill('"상담 관계" 상담');
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect(page.locator(".pdf-results blockquote strong")).toHaveText([
    "상담 관계",
    "상담 관계",
  ]);
});
test("keeps original Unicode offsets and case while treating punctuation literally", async ({
  page,
}) => {
  const text = "İstanbul ilişkisi ALPHA.* beta alphaZZ beta ALPHA.* beta";
  await mount(page, true, text);
  await page
    .getByLabel("PDF 검색어", { exact: true })
    .fill('”İstanbul ilişkisi“ "alpha.* beta"');
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect(page.locator(".pdf-results blockquote")).toHaveText(text);
  await expect(page.locator(".pdf-results blockquote strong")).toHaveText([
    "İstanbul ilişkisi",
    "ALPHA.* beta",
    "ALPHA.* beta",
  ]);
});
