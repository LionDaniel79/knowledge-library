import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
let app: string, pdf: string, css: string;
test.beforeAll(async () => {
  app = (
    await build({
      entryPoints: ["e2e/harness.tsx"],
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
    })
  ).outputFiles[0].text;
  pdf = (
    await build({
      stdin: {
        contents:
          "import {createRoot} from 'react-dom/client';import {PdfLibraryPanel} from './src/components/pdf-library-panel';createRoot(document.getElementById('root')).render(<PdfLibraryPanel onSaved={async()=>{}}/>);",
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
  css = await readFile("src/app/globals.css", "utf8");
});
const html = (js: string) =>
  `<!doctype html><html lang="ko"><style>${css}</style><div id="root"></div><script>${js.replace(/<\/script/gi, "<\\/script")}</script></html>`;
for (const width of [320, 390, 1440])
  test(`monthly bars keep the same bottom line with two-digit months at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route("https://library.test/", (r) =>
      r.fulfill({ contentType: "text/html", body: html(app) }),
    );
    await page.goto("https://library.test/");
    await page.getByRole("button", { name: "메뉴 열기", exact: true }).click();
    await page.getByRole("button", { name: "독서 통계", exact: true }).click();
    await expect(page.locator(".year-chart i")).toHaveCount(12);
    // Emulate larger system text within a narrow month slot: 1월 fits while
    // two-digit month names wrap unless the label has a stable baseline.
    await page.addStyleTag({
      content:
        ".year-chart small{font-size:24px;width:40px;word-break:break-all}",
    });
    const bottoms = await page
      .locator(".year-chart i")
      .evaluateAll((xs) => xs.map((x) => x.getBoundingClientRect().bottom));
    expect(Math.max(...bottoms) - Math.min(...bottoms)).toBeLessThan(1);
  });
test("one PDF search automatically continues in the same private-PC window and exposes only folder settings", async ({
  page,
  context,
}) => {
  let query = "";
  await page.route("https://library.test/**", (r) => {
    const u = new URL(r.request().url());
    if (u.pathname === "/")
      return r.fulfill({ contentType: "text/html", body: html(pdf) });
    if (u.pathname === "/api/pdf")
      return r.fulfill({
        json:
          u.searchParams.get("mode") === "search"
            ? {
                pcRedirect:
                  "https://library.example.ts.net/?view=pdf&pdfMode=search&pdfQuery=" +
                  encodeURIComponent(u.searchParams.get("q") ?? ""),
              }
            : { documents: [], total: 0 },
      });
    return r.fulfill({
      json: {
        local: false,
        available: false,
        pcOrigin: "https://library.example.ts.net",
      },
    });
  });
  await page.route("https://library.example.ts.net/**", (r) => {
    const u = new URL(r.request().url());
    if (u.pathname === "/")
      return r.fulfill({ contentType: "text/html", body: html(pdf) });
    if (u.pathname === "/api/pdf") {
      if (u.searchParams.get("mode") === "search")
        query = u.searchParams.get("q") ?? "";
      return r.fulfill({
        json: {
          documents: [],
          total: 1,
          hits: query
            ? [
                {
                  documentId: "11111111-1111-4111-8111-111111111111",
                  bookId: "x",
                  title: "원문 결과",
                  pageNumber: 7,
                  quote: query,
                  signature: "1:2",
                },
              ]
            : [],
        },
      });
    }
    if (u.pathname === "/api/pdf/connection")
      return r.fulfill({
        json: { available: true, root: "E:\\전자도서관", version: 0 },
      });
    return r.fulfill({ json: { local: true } });
  });
  await page.goto("https://library.test/");
  await expect(page.getByText("PDF 관리", { exact: true })).toHaveCount(0);
  await expect(
    page.getByText("자료 준비·오류 확인", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "PC의 PDF 원문 검색 열기", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "PDF 보관 폴더 설정", exact: true }),
  ).toBeVisible();
  await page.getByLabel("PDF 검색 범위").selectOption("search");
  await page.getByLabel("PDF 검색어", { exact: true }).fill("은혜와 상담");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect(page).toHaveURL(/library\.example\.ts\.net\/\?view=pdf/);
  await expect(
    page.getByRole("heading", { name: "원문 결과", exact: true }),
  ).toBeVisible();
  expect(query).toBe("은혜와 상담");
  expect(context.pages()).toHaveLength(1);
  await page
    .getByRole("button", { name: "PDF 보관 폴더 설정", exact: true })
    .click();
  await expect(page.getByLabel("외장하드의 PDF 폴더")).toHaveValue(
    "E:\\전자도서관",
  );
});
