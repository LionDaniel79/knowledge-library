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

test("a lost scan response recovers its accepted job and shows progress instead of a JSON parsing error", async ({
  page,
}) => {
  let accepted: any = null;
  await page.route("https://library.test/**", async (r) => {
    const u = new URL(r.request().url());
    if (u.pathname === "/")
      return r.fulfill({
        contentType: "text/html",
        body: `<!doctype html><style>${css}</style><div id="root"></div><script>${bundle.replace(/<\/script/gi, "<\\/script")}</script>`,
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
        expect(p.requestId).toMatch(/^[a-f0-9-]{36}$/);
        accepted = {
          job: {
            id: p.requestId,
            owner: "owner",
            root: p.root,
            state: "scanning",
            phase: "scanning",
            updatedAt: Date.now(),
            pauseRequested: false,
            error: "",
          },
          counts: { existing: 120 },
          total: 120,
        };
        return r.fulfill({ status: 502, body: "" });
      }
      return r.fulfill({ json: accepted ?? { job: null } });
    }
    return r.fulfill({ json: {} });
  });
  await page.goto("https://library.test/");
  await page
    .getByRole("button", { name: "PDF 보관 폴더 설정", exact: true })
    .click();
  await page
    .getByRole("button", { name: "PDF 일괄 등록", exact: true })
    .click();
  await expect(page.getByRole("status")).toHaveText("폴더 조사 중");
  await expect(page.getByText(/조사 120개/)).toBeVisible();
  await expect(page.getByText(/Unexpected end|execute 'json'/)).toHaveCount(0);
});

test("a delayed progress lookup keeps the known scan running and automatically displays completion without a false failure", async ({
  page,
}) => {
  const job = {
    id: "11111111-1111-4111-8111-111111111111",
    owner: "owner",
    root: "D:\\books",
    state: "scanning",
    phase: "scanning",
    updatedAt: Date.now(),
    pauseRequested: false,
    error: "",
  };
  let reads = 0;
  await page.route("https://library.test/**", async (r) => {
    const path = new URL(r.request().url()).pathname;
    if (path === "/")
      return r.fulfill({
        contentType: "text/html",
        body: `<!doctype html><style>${css}</style><div id="root"></div><script>${bundle.replace(/<\/script/gi, "<\\/script")}</script>`,
      });
    if (path === "/api/pdf/connection")
      return r.fulfill({
        json: { available: true, root: job.root, connected: true, version: 1 },
      });
    if (path === "/api/pdf/import") {
      reads++;
      if (reads === 1)
        return r.fulfill({ json: { job, counts: {}, total: 0 } });
      if (reads === 2) return r.fulfill({ status: 504, body: "" });
      return r.fulfill({
        json: {
          job: { ...job, state: "preview" },
          counts: { existing: 4101, excluded: 5208, new: 12 },
          total: 9321,
        },
      });
    }
    return r.fulfill({ json: {} });
  });
  await page.goto("https://library.test/");
  await page
    .getByRole("button", { name: "PDF 보관 폴더 설정", exact: true })
    .click();
  await expect(
    page.getByText("진행 상태를 다시 확인하고 있습니다.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText("폴더 조사 중", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText("조사 완료", { exact: true })).toBeVisible();
  await expect(page.getByText(/조사 9321개 · 신규 후보 12개/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "등록 시작", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("진행 상태를 다시 확인하고 있습니다.", {
      exact: true,
    }),
  ).toHaveCount(0);
});

for (const transient of [true, false])
  test(`a retry ${transient ? "recovers an accepted command after a lost acknowledgement" : "keeps a real validation failure visible"}`, async ({
    page,
  }) => {
    const job = {
      id: "11111111-1111-4111-8111-111111111111",
      owner: "owner",
      root: "D:\\books",
      state: "complete",
      phase: "indexing",
      updatedAt: Date.now(),
      pauseRequested: false,
      error: "",
    };
    let state: any = {
      job,
      counts: { registered: 2, enriched: 2, indexed: 0, errors: 1 },
      total: 3,
    };
    await page.route("https://library.test/**", async (r) => {
      const path = new URL(r.request().url()).pathname;
      if (path === "/")
        return r.fulfill({
          contentType: "text/html",
          body: `<!doctype html><style>${css}</style><div id="root"></div><script>${bundle.replace(/<\/script/gi, "<\\/script")}</script>`,
        });
      if (path === "/api/pdf/connection")
        return r.fulfill({
          json: {
            available: true,
            root: job.root,
            connected: true,
            version: 1,
          },
        });
      if (path === "/api/pdf/import") {
        if (r.request().method() === "POST") {
          expect(r.request().postDataJSON().action).toBe("retry");
          if (!transient)
            return r.fulfill({
              status: 400,
              json: { error: "먼저 작업을 중지해 주세요." },
            });
          state = {
            job: { ...job, updatedAt: job.updatedAt + 1000 },
            counts: { registered: 3, enriched: 3, indexed: 3, errors: 0 },
            total: 3,
          };
          return r.fulfill({ status: 502, body: "" });
        }
        return r.fulfill({ json: state });
      }
      return r.fulfill({ json: {} });
    });
    await page.goto("https://library.test/");
    await page
      .getByRole("button", { name: "PDF 보관 폴더 설정", exact: true })
      .click();
    await page
      .getByRole("button", { name: "오류 재시도", exact: true })
      .click();
    if (transient) {
      await expect(
        page.getByText(/기본 등록 3개 · 서지 보완 확인 3개 · 본문 색인 3개/),
      ).toBeVisible();
      await expect(page.getByRole("alert")).toHaveCount(0);
    } else
      await expect(page.getByRole("alert")).toHaveText(
        "먼저 작업을 중지해 주세요.",
      );
  });
