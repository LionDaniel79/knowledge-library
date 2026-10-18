import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
let bundle: string, css: string;
test.beforeAll(async () => {
  css = await readFile("src/app/globals.css", "utf8");
  bundle = (
    await build({
      stdin: {
        contents: `import {createRoot} from 'react-dom/client';import {useSyncExternalStore} from 'react';import {openReplica} from './src/client/replica/indexed-db';import {resourceFixture} from './tests/helpers/replica-resources';import {createLibraryRuntime} from './src/client/replica/runtime';import {ReplicaProvider} from './src/components/replica/provider';import {SyncSettings} from './src/components/replica/sync-settings';import {withReplicaLeader} from './src/client/replica/leadership';window.start=async()=>{const s=await openReplica('resources');if(!(await s.checkpoint())){const f=await resourceFixture(s);f.repo.close();}window.store=s;const runtime=createLibraryRuntime('resources',s,await s.checkpoint());window.runtime=runtime;window.hold=()=>withReplicaLeader('resources',async()=>{document.body.dataset.held='1';await new Promise(r=>setTimeout(r,5000));},{storage:s,locks:null,leaseMs:500});function Widget(){const snap=useSyncExternalStore(runtime.subscribe,runtime.getSnapshot);return <ReplicaProvider runtime={runtime}><span data-testid="revision">{snap.revision}</span><SyncSettings onClose={()=>{}}/></ReplicaProvider>}createRoot(document.getElementById('root')).render(<Widget/>);};`,
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
        "import.meta.url": '"https://settings.test/main.js"',
      },
    })
  ).outputFiles[0].text;
});
async function setup(context: any) {
  let running = 0,
    maximum = 0,
    epoch = "";
  await context.route("https://settings.test/", (r: any) =>
    r.fulfill({
      contentType: "text/html",
      body: '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div>',
    }),
  );
  await context.route("https://settings.test/api/**", (r: any) =>
    r.fulfill({ status: 503, json: { error: "unavailable" } }),
  );
  await context.route("https://settings.test/api/sync/session", (r: any) =>
    r.fulfill({ json: { ownerId: "resources" } }),
  );
  await context.route("https://settings.test/api/auth/get-session", (r: any) =>
    r.fulfill({
      json: { user: { id: "resources" }, session: { id: "fixture-session" } },
    }),
  );
  await context.route(
    "https://settings.test/api/sync/meta?*",
    async (r: any) => {
      running++;
      maximum = Math.max(maximum, running);
      await new Promise((resolve) => setTimeout(resolve, 80));
      running--;
      await r.fulfill({
        json: {
          epoch,
          head: "1",
          floor: "0",
          protocol: 1,
          entities: {},
          totalRows: 0,
          totalBytes: 0,
        },
      });
    },
  );
  async function mount(page: any) {
    await page.goto("https://settings.test/");
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: bundle });
    await page.evaluate(() => (window as any).start());
    epoch = await page.evaluate(
      async () => (await (window as any).store.checkpoint()).epoch,
    );
    await expect(page.getByRole("dialog")).toBeVisible();
  }
  return { mount, maximum: () => maximum };
}
test("shows honest persistence and full-copy status, keeps pending edits and serializes two tabs", async ({
  context,
  page,
}) => {
  const f = await setup(context);
  await page.addInitScript(() => {
    Object.defineProperty(navigator.storage, "persist", {
      value: async () => false,
    });
    Object.defineProperty(navigator.storage, "persisted", {
      value: async () => false,
    });
  });
  await f.mount(page);
  const other = await context.newPage();
  await f.mount(other);
  await expect(page.getByRole("dialog")).toContainText("기기에 저장됨");
  await page.getByRole("button", { name: "자료 보관 보호 요청" }).click();
  await expect(page.getByRole("alert")).toContainText("허용하지 않았습니다");
  await Promise.all([
    page.evaluate(() => (window as any).runtime.sync({ reason: "manual" })),
    other.evaluate(() => (window as any).runtime.sync({ reason: "manual" })),
  ]);
  expect(f.maximum()).toBe(1);
  const before = await other.getByTestId("revision").textContent();
  await page.evaluate(async () => {
    await (window as any).runtime.queue("/api/library", {
      requestId: crypto.randomUUID(),
      type: "addNote",
      payload: { title: "두 창에서도 보관", content: "내 글", kind: "thought" },
    });
  });
  await expect
    .poll(async () => Number(await other.getByTestId("revision").textContent()))
    .toBeGreaterThan(Number(before));
  await expect(other.getByRole("dialog")).toContainText("1개 전송 대기");
  await expect(
    page.getByRole("button", { name: "이 기기의 내려받은 자료 지우기" }),
  ).toBeDisabled();
  await page.bringToFront();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.clientWidth))
    .toBe(390);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    JSON.stringify(
      await page.evaluate(() => ({
        width: innerWidth,
        scroll: document.documentElement.scrollWidth,
        bad: [...document.querySelectorAll("*")]
          .map((e) => ({
            tag: e.tagName,
            cls: e.className,
            text: e.textContent?.slice(0, 40),
            right: e.getBoundingClientRect().right,
            width: e.getBoundingClientRect().width,
          }))
          .filter((e) => e.right > innerWidth + 1)
          .slice(0, 10),
      })),
    ),
  ).toBe(true);
});
test("takes over an expired lease after the owning tab closes", async ({
  context,
  page,
}) => {
  const f = await setup(context);
  await f.mount(page);
  const other = await context.newPage();
  await f.mount(other);
  await page.evaluate(() => {
    void (window as any).hold();
  });
  await expect(page.locator("body")).toHaveAttribute("data-held", "1");
  await page.close();
  await other.evaluate(() =>
    (window as any).runtime.sync({ reason: "manual" }),
  );
  await expect(other.getByRole("dialog")).toContainText("동기화 완료");
});
test("cleans only old device copies while retaining the current generation and unsent note", async ({
  context,
  page,
}) => {
  const f = await setup(context);
  await f.mount(page);
  await page.evaluate(async () => {
    const runtime = (window as any).runtime,
      s = runtime.storage,
      old = await s.checkpoint();
    const g = await s.createGeneration({
      epoch: old.epoch,
      cursor: old.cursor,
    });
    const rows = await s.readPage("library_books", {
      generation: old.generation,
    });
    await s.stageRows(g.generation, rows.rows);
    await s.setCheckpoint(g.generation, { complete: true });
    await s.promoteGeneration(g.generation);
    await runtime.queue("/api/library", {
      requestId: crypto.randomUUID(),
      type: "addNote",
      payload: {
        title: "정리해도 남는 글",
        content: "미전송",
        kind: "thought",
      },
    });
  });
  const clean = page.getByRole("button", {
    name: "불필요한 기기 사본 정리",
    exact: true,
  });
  await expect(clean).toBeEnabled();
  await clean.click();
  await expect(page.getByRole("alert")).toContainText("이전 기기 사본 1개");
  expect(
    await page.evaluate(
      async () => (await (window as any).store.listGenerations()).length,
    ),
  ).toBe(1);
  expect(
    await page.evaluate(
      async () => (await (window as any).store.listOutbox()).length,
    ),
  ).toBe(1);
  await expect(
    page.getByRole("button", { name: "이 기기의 내려받은 자료 지우기" }),
  ).toBeDisabled();
});
