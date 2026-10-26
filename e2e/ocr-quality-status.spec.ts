import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
let bundle: string, css: string;
const running = () => ({
  job: {
    id: "11111111-1111-4111-8111-111111111111",
    state: "running",
    mode: "running",
    scope: "all",
    updated: Date.now() / 1000,
    pause: 0,
    error: "",
    sample: 0,
  },
  total: 100,
  counts: { pending: 60, ready: 20, review: 15, rejected: 5 },
  pages: [],
  history: [],
});
test.beforeAll(async () => {
  bundle = (
    await build({
      stdin: {
        contents:
          "import {createRoot} from 'react-dom/client';import {PdfOcrSettings} from './src/components/pdf-ocr-settings';import {registerLibraryRuntime} from './src/client/replica/request';registerLibraryRuntime(null, async()=>{await fetch('/api/auth/get-session');});createRoot(document.getElementById('root')).render(<PdfOcrSettings/>);",
        resolveDir: process.cwd(),
        loader: "tsx",
      },
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      jsx: "automatic",
    })
  ).outputFiles[0].text;
  css = await readFile("src/app/globals.css", "utf8");
});
async function shell(route: any) {
  return route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><div id="root"></div><script>${bundle.replace(/<\/script/gi, "<\\/script")}</script>`,
  });
}
test("uses the existing verified session before reading an already-running OCR job", async ({
  page,
}) => {
  let renewed = false,
    commands = 0;
  await page.route("https://library.test/**", async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === "/") return shell(route);
    if (u.pathname === "/api/auth/get-session") {
      renewed = true;
      return route.fulfill({ json: {} });
    }
    if (route.request().method() === "POST") commands++;
    return route.fulfill(
      renewed
        ? { json: running() }
        : { status: 401, json: { error: "로그인이 필요합니다." } },
    );
  });
  await page.goto("https://library.test/");
  await page.getByText("OCR 품질·다시 인식", { exact: true }).click();
  await expect(page.getByText("본문 재인식 중", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("progressbar", { name: "OCR 재인식 진행률" }),
  ).toHaveAttribute("value", "40");
  await expect(
    page.getByRole("button", { name: "전체 OCR 다시하기", exact: true }),
  ).toBeDisabled();
  expect(commands).toBe(0);
});
test("discovers a PC job that appears after the initial empty response", async ({
  page,
}) => {
  let state: any = { job: null },
    reads = 0;
  await page.clock.install();
  await page.route("https://library.test/**", async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === "/") return shell(route);
    if (u.pathname === "/api/auth/get-session")
      return route.fulfill({ json: {} });
    reads++;
    return route.fulfill({ json: state });
  });
  await page.goto("https://library.test/");
  await page.getByText("OCR 품질·다시 인식", { exact: true }).click();
  await expect.poll(() => reads).toBeGreaterThan(0);
  state = running();
  await page.clock.fastForward(4500);
  await expect(page.getByText("본문 재인식 중", { exact: true })).toBeVisible();
  expect(reads).toBeGreaterThan(1);
});
test("blocks new jobs while loading and lets a failed status read recover manually", async ({
  page,
}) => {
  let release: (() => void) | undefined,
    failed = true;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  await page.route("https://library.test/**", async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === "/") return shell(route);
    if (u.pathname === "/api/auth/get-session")
      return route.fulfill({ json: {} });
    await gate;
    return route.fulfill(
      failed
        ? { status: 503, json: { error: "조회 연결 지연" } }
        : { json: running() },
    );
  });
  await page.goto("https://library.test/");
  await page.getByText("OCR 품질·다시 인식", { exact: true }).click();
  await expect(
    page.getByRole("button", { name: "전체 OCR 다시하기", exact: true }),
  ).toBeDisabled();
  release!();
  await expect(page.getByRole("alert")).toContainText("조회 연결 지연");
  failed = false;
  await page
    .getByRole("button", { name: "진행 현황 새로고침", exact: true })
    .click();
  await expect(page.getByText("본문 재인식 중", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("does not let an older status response hide a newly started job", async ({
  page,
}) => {
  await page.clock.install();
  let reads = 0,
    oldDelivered = false,
    state: any = { job: null },
    releaseOld: (() => void) | undefined;
  const oldGate = new Promise<void>((r) => {
    releaseOld = r;
  });
  await page.route("https://library.test/**", async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === "/") return shell(route);
    if (u.pathname === "/api/auth/get-session")
      return route.fulfill({ json: {} });
    if (route.request().method() === "POST") {
      state = running();
      return route.fulfill({ json: state });
    }
    reads++;
    if (reads === 2) {
      await oldGate;
      oldDelivered = true;
      return route.fulfill({ json: { job: null } }).catch(() => {});
    }
    return route.fulfill({ json: state });
  });
  await page.goto("https://library.test/");
  await page.getByText("OCR 품질·다시 인식", { exact: true }).click();
  await expect(
    page.getByRole("button", { name: "표본 5쪽 비교", exact: true }),
  ).toBeEnabled();
  await page.clock.fastForward(4500);
  await expect.poll(() => reads).toBe(2);
  await page
    .getByRole("button", { name: "표본 5쪽 비교", exact: true })
    .click();
  await expect(page.getByText("본문 재인식 중", { exact: true })).toBeVisible();
  const staleResponse = page.waitForResponse(
    (r) =>
      r.url().includes("/api/pdf/reprocess") && r.request().method() === "GET",
  );
  releaseOld!();
  await (await staleResponse).finished();
  await expect.poll(() => oldDelivered).toBe(true);
  await page.clock.runFor(100);
  expect(
    await page.getByText("본문 재인식 중", { exact: true }).isVisible(),
  ).toBe(true);
  expect(
    await page
      .getByRole("button", { name: "전체 OCR 다시하기", exact: true })
      .isEnabled(),
  ).toBe(false);
});
