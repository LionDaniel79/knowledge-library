import { test, expect, type Page, type Route } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";

let bundle: string, css: string;
test.use({ viewport: { width: 1600, height: 1000 } });
test.beforeAll(async () => {
  css = await readFile("src/app/globals.css", "utf8");
  bundle = (
    await build({
      stdin: {
        contents: `import {createRoot} from 'react-dom/client';
import {useEffect,useState} from 'react';
import {resourceFixture} from './tests/helpers/replica-resources';
import {createLibraryRuntime} from './src/client/replica/runtime';
import {ReplicaProvider} from './src/components/replica/provider';
import {LibraryApp} from './src/components/library-app';
import {sha256Bytes} from './src/lib/replica/codec';
import {createSyncCursor} from './src/lib/replica/contracts';
window.start=async()=>{
  const f=await resourceFixture(),initial=await f.repo.overview();f.repo.close();
  const runtime=createLibraryRuntime(f.s.owner,f.s,await f.s.checkpoint());
  window.runtime=runtime;window.catalogReads=0;
  const tracked=new Proxy(initial,{get(target,key,receiver){if(key==='catalog')window.catalogReads++;return Reflect.get(target,key,receiver);}});
  const row=await f.s.readRow('library_books',JSON.stringify([f.book])),value=JSON.parse(row.inline);
  value.title='동기화로 갱신된 책';const inline=JSON.stringify(value),bytes=new TextEncoder().encode(inline),cp=await f.s.checkpoint();
  window.remote={meta:{epoch:cp.epoch,head:'2',floor:'0',protocol:1,entities:{},totalRows:cp.rows,totalBytes:cp.bytes},page:{epoch:cp.epoch,head:'2',cursor:createSyncCursor({owner:f.s.owner,epoch:cp.epoch,after:'2'}),hasMore:false,rows:[{...row,revision:'2',inline,bytes:bytes.length,sha256:await sha256Bytes(bytes)}]}};
  function App(){const[data,setData]=useState(tracked);useEffect(()=>{let revision=runtime.getSnapshot().revision;return runtime.subscribe(()=>{const next=runtime.getSnapshot().revision;if(next!==revision){revision=next;void runtime.repository.overview().then(setData);}})},[]);return <ReplicaProvider runtime={runtime}><LibraryApp initial={data} today='2026-10-29' ownerId='resources'/></ReplicaProvider>}
  createRoot(document.getElementById('root')).render(<App/>);
};`,
        resolveDir: process.cwd(),
        loader: "tsx",
      },
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      jsx: "automatic",
      define: {
        "process.env.NODE_ENV": '"production"',
        "import.meta.url": '"https://background-sync.test/main.js"',
      },
    })
  ).outputFiles[0].text;
});

async function mount(page: Page) {
  let held: Route | undefined,
    metaRequests = 0;
  await page.route("https://background-sync.test/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div>',
    }),
  );
  await page.route("https://background-sync.test/api/**", (route) =>
    route.fulfill({ status: 503, json: { error: "검사용 응답" } }),
  );
  await page.route("**/api/sync/session", (route) =>
    route.fulfill({ json: { ownerId: "resources" } }),
  );
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({
      json: { user: { id: "resources" }, session: { id: "test-session" } },
    }),
  );
  await page.route("**/api/sync/meta?*", (route) => {
    metaRequests++;
    held = route;
  });
  await page.route("**/api/sync/changes?*", async (route) =>
    route.fulfill({
      json: await page.evaluate(() => (window as any).remote.page),
    }),
  );
  await page.goto("https://background-sync.test/");
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => (window as any).start());
  await expect(
    page.getByRole("heading", { name: "나의 서재", exact: true }),
  ).toBeVisible();
  return {
    wait: () => expect.poll(() => !!held).toBe(true),
    requests: () => metaRequests,
    async release(failed = false) {
      await held!.fulfill(
        failed
          ? { status: 503, json: { error: "잠시 후 다시 동기화해 주세요." } }
          : { json: await page.evaluate(() => (window as any).remote.meta) },
      );
    },
  };
}

async function navigate(page: Page, label: string) {
  await page.getByRole("button", { name: "메뉴 열기", exact: true }).click();
  await page
    .getByRole("navigation", { name: "주 메뉴" })
    .getByRole("button", { name: label })
    .click();
}

test("keeps the running sync alive when the home sync button unmounts on menu navigation", async ({
  page,
}) => {
  const f = await mount(page);
  await page.getByRole("button", { name: "동기화", exact: true }).click();
  await f.wait();
  await navigate(page, "소장 도서");
  await expect(
    page.getByRole("heading", { name: "소장 도서", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as any).runtime.getSnapshot().status.phase,
    ),
  ).toBe("preparing");
  await f.release();
  await expect(
    page.getByText("동기화로 갱신된 책", { exact: true }).first(),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as any).runtime.getSnapshot().status.phase,
    ),
  ).toBe("complete");
  expect(f.requests()).toBe(1);
});

test("shows progress and completion after navigating away from the sync launcher", async ({
  page,
}) => {
  const f = await mount(page);
  await page.getByRole("button", { name: "동기화", exact: true }).click();
  await f.wait();
  await navigate(page, "소장 도서");
  await expect(
    page.getByRole("button", { name: "동기화", exact: true }),
  ).toBeDisabled();
  await expect(page.locator(".sync-summary")).toContainText(
    "다른 메뉴를 사용해도 계속",
  );
  await f.release();
  await expect(page.locator(".sync-summary")).toHaveText("동기화 완료");
  await expect(
    page.getByRole("button", { name: "동기화", exact: true }),
  ).toBeEnabled();
  expect(f.requests()).toBe(1);
});

test("releases the settings dialog immediately and reports a later background failure in the app", async ({
  page,
}) => {
  const f = await mount(page);
  await page
    .getByRole("button", { name: "기기 저장·동기화", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "기기 저장·동기화" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "동기화 재개", exact: true }).click();
  await f.wait();
  await expect(
    page.getByRole("dialog", { name: "기기 저장·동기화" }),
  ).not.toBeVisible();
  await navigate(page, "독서 달력");
  await expect(
    page.getByRole("heading", { name: "독서 달력", exact: true }),
  ).toBeVisible();
  await f.release(true);
  await expect(page.getByRole("alert")).toContainText(
    "잠시 후 다시 동기화해 주세요.",
  );
  await expect(page.locator(".sync-summary")).toHaveText("동기화 실패");
  await expect(
    page.getByRole("button", { name: "동기화", exact: true }),
  ).toBeEnabled();
});

test("does not rerender library data for sync progress without a data revision", async ({
  page,
}) => {
  const f = await mount(page);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const before = await page.evaluate(() => (window as any).catalogReads);
  await page.getByRole("button", { name: "동기화", exact: true }).click();
  await f.wait();
  expect(await page.evaluate(() => (window as any).catalogReads)).toBe(before);
  await f.release();
  await expect(page.locator(".sync-summary")).toHaveText("동기화 완료");
});

test("keeps background progress and menu navigation usable on a narrow phone screen", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const f = await mount(page);
  await page.getByRole("button", { name: "동기화", exact: true }).click();
  await f.wait();
  await navigate(page, "독서 통계");
  await expect(
    page.getByRole("heading", { name: "독서 통계", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".sync-summary")).toContainText(
    "다른 메뉴를 사용해도 계속",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await f.release();
  await expect(page.locator(".sync-summary")).toHaveText("동기화 완료");
  await page.screenshot({
    path: testInfo.outputPath("sync-phone.png"),
  });
});
