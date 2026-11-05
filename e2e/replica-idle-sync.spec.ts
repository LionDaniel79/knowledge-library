import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";

let bundle: string;
test.beforeAll(async () => {
  const runtimePath =
    process.cwd().replaceAll("\\", "/") + "/src/client/replica/runtime.ts";
  bundle = (
    await build({
      stdin: {
        contents: `import{createRoot}from'react-dom/client';import{ReplicaEntry}from'./src/components/replica/entry';createRoot(document.getElementById('root')).render(<ReplicaEntry available={true}/>);`,
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
        "import.meta.url": '"https://idle-sync.test/app.js"',
      },
      plugins: [
        {
          name: "isolated-device",
          setup(b) {
            b.onResolve({ filter: /\/replica\/runtime$/ }, () => ({
              path: "tracked-runtime",
              namespace: "idle-runtime",
            }));
            b.onLoad({ filter: /.*/, namespace: "idle-runtime" }, () => ({
              loader: "ts",
              resolveDir: process.cwd(),
              contents: `import{createLibraryRuntime as original}from ${JSON.stringify(runtimePath)};export{verifiedSyncOwner}from ${JSON.stringify(runtimePath)};window.syncCalls=0;export function createLibraryRuntime(...args){const runtime=original(...args);return{...runtime,sync(options){window.syncCalls++;return runtime.sync(options)}}}`,
            }));
            b.onResolve({ filter: /\/replica\/indexed-db$/ }, () => ({
              path: "memory-device",
              namespace: "idle-test",
            }));
            b.onLoad({ filter: /.*/, namespace: "idle-test" }, () => ({
              loader: "ts",
              resolveDir: process.cwd(),
              contents: `import{resourceFixture}from'./tests/helpers/replica-resources';export async function openReplica(){const f=await resourceFixture();f.repo.close();const cp=await f.s.checkpoint();window.meta={epoch:cp.epoch,head:'1',floor:'0',protocol:1,entities:{},totalRows:cp.rows,totalBytes:cp.bytes};return f.s;}`,
            }));
          },
        },
      ],
    })
  ).outputFiles[0].text;
});

async function mount(page: Page) {
  let checks = 0;
  await page.clock.install();
  await page.route("https://idle-sync.test/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/")
      return route.fulfill({
        contentType: "text/html",
        body: '<div id="root"></div>',
      });
    if (path === "/api/sync/session")
      return route.fulfill({ json: { ownerId: "resources" } });
    if (path === "/api/auth/get-session")
      return route.fulfill({
        json: {
          user: { id: "resources" },
          session: { id: "isolated-session" },
        },
      });
    if (path === "/api/sync/meta") {
      checks++;
      return route.fulfill({
        json: await page.evaluate(() => (window as any).meta),
      });
    }
    return route.fulfill({ status: 503, json: { error: "isolated test" } });
  });
  await page.goto("https://idle-sync.test/");
  await page.addScriptTag({ content: bundle });
  await expect(
    page.getByRole("heading", { name: "나의 서재", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".sync-summary")).toHaveText("동기화 완료");
  return {
    checks: () => checks,
    calls: () => page.evaluate(() => (window as any).syncCalls),
  };
}

test("stops repeated checks in an unused foreground window, resumes on interaction and keeps explicit sync available", async ({
  page,
}) => {
  const f = await mount(page);
  // A recently active window still receives changes from other devices.
  const initial = f.checks();
  await page.clock.runFor(60000);
  await expect.poll(f.checks).toBe(initial + 1);
  await expect(page.locator(".sync-summary")).toHaveText("동기화 완료");
  // Move beyond the five-minute inactivity cutoff, then measure another hour.
  await page.clock.fastForward(6 * 60000);
  await expect(page.locator(".sync-summary")).toHaveText("동기화 완료");
  const idle = await f.calls();
  await page.clock.fastForward(60 * 60000);
  expect(await f.calls()).toBe(idle);
  await page.evaluate(() => window.dispatchEvent(new Event("pointerdown")));
  await expect.poll(f.calls).toBe(idle + 1);
  await expect(page.locator(".sync-summary")).toHaveText("동기화 완료");
  await page.getByRole("button", { name: "동기화", exact: true }).click();
  await expect.poll(f.calls).toBe(idle + 2);
});

test("scrolling keeps a reading session active and foreground/reconnection resumes an idle one", async ({
  page,
}) => {
  const f = await mount(page);
  await page.clock.fastForward(4 * 60000);
  await page.evaluate(() => window.dispatchEvent(new Event("scroll")));
  await expect(page.locator(".sync-summary")).toHaveText("동기화 완료");
  const reading = f.checks();
  await page.clock.fastForward(4 * 60000);
  await expect.poll(f.checks).toBe(reading + 1);
  for (const event of ["focus", "online"]) {
    await page.clock.fastForward(6 * 60000);
    await expect(page.locator(".sync-summary")).toHaveText("동기화 완료");
    const before = f.checks();
    await page.evaluate((name) => window.dispatchEvent(new Event(name)), event);
    await expect.poll(f.checks).toBe(before + 1);
    await expect(page.locator(".sync-summary")).toHaveText("동기화 완료");
  }
});
