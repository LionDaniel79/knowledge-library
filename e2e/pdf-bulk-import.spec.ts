import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
let bundle: string, css: string;
test.beforeAll(async () => {
  bundle = (
    await build({
      stdin: {
        contents:
          "import {createRoot} from 'react-dom/client';import {PdfConnection} from './src/components/pdf-connection';createRoot(document.getElementById('root')).render(<PdfConnection/>);",
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
for (const width of [320, 390, 1440])
  test(`first-use bulk preview, background continuation and adjacent buttons at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    let state: any = { job: null };
    const job = {
      id: "11111111-1111-4111-8111-111111111111",
      owner: "owner",
      root: "D:\\books",
      state: "preview",
      phase: "scanning",
      pauseRequested: false,
      updatedAt: Date.now(),
      error: "",
    };
    await page.route("https://library.test/**", async (r) => {
      const u = new URL(r.request().url());
      if (u.pathname === "/")
        return r.fulfill({
          contentType: "text/html",
          body: `<!doctype html><html lang="ko"><style>${css}</style><div id="root"></div><script>${bundle.replace(/<\/script/gi, "<\\/script")}</script></html>`,
        });
      if (u.pathname === "/api/pdf/connection")
        return r.fulfill({
          json: {
            available: true,
            root: "D:\\books",
            connected: false,
            version: 0,
          },
        });
      if (u.pathname === "/api/pdf/import") {
        if (r.request().method() === "POST") {
          const p = r.request().postDataJSON();
          if (p.action === "scan")
            state = {
              job: { ...job },
              total: 3,
              counts: { new: 2, excluded: 1 },
              issues: [],
              issueCount: 0,
            };
          if (p.action === "start")
            state = {
              ...state,
              job: { ...job, state: "registering", phase: "registering" },
            };
        }
        return r.fulfill({ json: state });
      }
      return r.fulfill({ json: {} });
    });
    await page.goto("https://library.test/");
    await page
      .getByRole("button", { name: "PDF 보관 폴더 설정", exact: true })
      .click();
    const check = page.getByRole("button", { name: "연결 검사", exact: true }),
      bulk = page.getByRole("button", { name: "PDF 일괄 등록", exact: true });
    await expect(bulk).toBeEnabled();
    const a = await check.boundingBox(),
      b = await bulk.boundingBox();
    expect(Math.abs(a!.y - b!.y)).toBeLessThan(2);
    expect(b!.x).toBeGreaterThan(a!.x);
    await bulk.click();
    await expect(page.getByRole("status")).toHaveText("조사 완료");
    await expect(
      page.getByText("조사 3개 · 신규 후보 2개", { exact: false }),
    ).toBeVisible();
    await page.getByRole("button", { name: "등록 시작", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "일시 중지", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "닫기", exact: true }).click();
    state = {
      ...state,
      job: { ...job, state: "complete" },
      counts: {
        registered: 1,
        duplicate: 1,
        excluded: 1,
        indexed: 1,
        enriched: 1,
      },
    };
    await page
      .getByRole("button", { name: "PDF 보관 폴더 설정", exact: true })
      .click();
    await expect(page.getByRole("status")).toHaveText("등록 작업 완료");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
