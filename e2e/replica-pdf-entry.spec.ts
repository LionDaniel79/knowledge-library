import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { emptyLibrary } from "../src/lib/domain";

let bundle: string;
test.beforeAll(async () => {
  bundle = (
    await build({
      stdin: {
        contents: `import {createRoot} from 'react-dom/client';import {ReplicaEntry} from './src/components/replica/entry';window.mount=()=>createRoot(document.getElementById('root')).render(<ReplicaEntry available={true} initialView="pdf" deferPdfAutoSync={true}/>);`,
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
  await expect
    .poll(() => requests.some((p) => p.startsWith("/api/pdf?")))
    .toBe(true);
  return requests;
}

test("private PDF entry and focus/online resume do not start a full library download", async ({
  page,
}) => {
  const requests = await openPdf(page);
  await page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(
    page.getByRole("button", { name: "동기화", exact: true }),
  ).toBeEnabled();
  expect(
    requests.filter((p) =>
      /^\/api\/sync\/(meta|scan|changes|coverage)/.test(p),
    ),
  ).toEqual([]);
});

test("manual sync remains available from a private PDF entry", async ({
  page,
}) => {
  const requests = await openPdf(page);
  await page.getByRole("button", { name: "동기화", exact: true }).click();
  await expect
    .poll(() => requests.some((p) => p.startsWith("/api/sync/meta?")))
    .toBe(true);
});

test("leaving the private PDF entry starts normal automatic library sync", async ({
  page,
}) => {
  const requests = await openPdf(page);
  await page.getByRole("button", { name: "메뉴 열기", exact: true }).click();
  await page.getByRole("button", { name: "나의 서재", exact: true }).click();
  await expect
    .poll(() => requests.some((p) => p.startsWith("/api/sync/meta?")))
    .toBe(true);
});
