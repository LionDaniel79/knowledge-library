import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { emptyLibrary } from "../src/lib/domain";

let bundle: string;
test.beforeAll(async () => {
  bundle = (
    await build({
      stdin: {
        contents: `import {createRoot} from 'react-dom/client';import {ReplicaEntry} from './src/components/replica/entry';window.mount=()=>createRoot(document.getElementById('root')).render(<ReplicaEntry available={true}/>);`,
        loader: "tsx",
        resolveDir: process.cwd(),
      },
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      jsx: "automatic",
      define: {
        "process.env.NODE_ENV": '"production"',
        "import.meta.url": '"https://pdf-entry.test/app.js"',
      },
    })
  ).outputFiles[0].text;
});

async function openPdf(page: Page) {
  const requests: string[] = [];
  await page.route("https://pdf-entry.test/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/")
      return route.fulfill({
        contentType: "text/html",
        body: '<div id="root"></div>',
      });
    requests.push(url.pathname + url.search);
    if (url.pathname === "/api/sync/session")
      return route.fulfill({ json: { ownerId: "pdf-entry-owner" } });
    if (url.pathname === "/api/auth/get-session")
      return route.fulfill({
        json: {
          user: { id: "pdf-entry-owner" },
          session: { id: "test-session" },
        },
      });
    if (url.pathname === "/api/library")
      return route.fulfill({ json: emptyLibrary() });
    if (url.pathname === "/api/pdf")
      return route.fulfill({
        json: { documents: [], hits: [], total: 0, summary: null },
      });
    return route.fulfill({
      status: 503,
      json: { error: "fixture unavailable" },
    });
  });
  await page.goto("https://pdf-entry.test/?view=pdf");
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => (window as any).mount());
  await expect(page.locator(".workspace")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "PDF 원문 검색", exact: true }),
  ).toHaveCount(0);
  return requests;
}

test("an old PDF bookmark opens the metadata library without original-search or PC requests", async ({
  page,
}) => {
  const requests = await openPdf(page);
  await expect(
    page.getByRole("button", { name: "동기화", exact: true }),
  ).toBeEnabled();
  expect(
    requests.filter((p) => p.startsWith("/api/pdf") || p.startsWith("/api/pc")),
  ).toEqual([]);
  await expect
    .poll(() => requests.some((p) => p.startsWith("/api/sync/meta?")))
    .toBe(true);
});

test("ordinary manual sync remains available after opening an old PDF bookmark", async ({
  page,
}) => {
  const requests = await openPdf(page);
  await page.getByRole("button", { name: "동기화", exact: true }).click();
  await expect
    .poll(() => requests.some((p) => p.startsWith("/api/sync/meta?")))
    .toBe(true);
  expect(requests.filter((p) => p.startsWith("/api/pdf"))).toEqual([]);
});
