import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
let server: Server,
  origin: string,
  bundle: string,
  worker: string,
  css: string,
  sw: string,
  version = "pwa-v1",
  owner = "resources",
  epoch = "";
test.beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", origin);
    res.setHeader("Cache-Control", "no-store");
    if (url.pathname === "/sw.js") {
      res.setHeader("Content-Type", "application/javascript");
      res.end(sw);
    } else if (url.pathname === "/replica-shell.json") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          version,
          assets: [
            `/_next/static/main-${version}.js`,
            "/_next/static/search-worker.ts",
            "/_next/static/app.css",
          ],
        }),
      );
    } else if (url.pathname.startsWith("/_next/static/main-")) {
      res.setHeader("Content-Type", "application/javascript");
      res.end(
        `window.appBuild=${JSON.stringify(url.pathname.includes("pwa-v2") ? "pwa-v2" : "pwa-v1")};` +
          bundle,
      );
    } else if (url.pathname === "/_next/static/search-worker.ts") {
      res.setHeader("Content-Type", "application/javascript");
      res.end(worker);
    } else if (url.pathname === "/_next/static/app.css") {
      res.setHeader("Content-Type", "text/css");
      res.end(css);
    } else if (url.pathname === "/test-fixture/state") {
      let body = "";
      for await (const part of req) body += part;
      epoch = JSON.parse(body).epoch;
      res.end("ok");
    } else if (url.pathname === "/api/auth/get-session") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          user: { id: owner },
          session: { id: "fixture-session" },
        }),
      );
    } else if (url.pathname === "/api/sync/session") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ownerId: owner }));
    } else if (url.pathname === "/api/sync/meta" && owner === "resources") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          epoch,
          head: "1",
          floor: "0",
          protocol: 1,
          entities: {},
          totalRows: 0,
          totalBytes: 0,
        }),
      );
    } else if (url.pathname.startsWith("/api/")) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end('{"error":"test server has no business data"}');
    } else if (
      [
        "/offline.html",
        "/offline.js",
        "/offline.css",
        "/library-icon.svg",
      ].includes(url.pathname)
    ) {
      res.setHeader(
        "Content-Type",
        url.pathname.endsWith(".js")
          ? "application/javascript"
          : url.pathname.endsWith("css")
            ? "text/css"
            : url.pathname.endsWith("svg")
              ? "image/svg+xml"
              : "text/html",
      );
      res.end(await readFile("public" + url.pathname));
    } else {
      res.setHeader("Content-Type", "text/html");
      res.setHeader("X-Library-Public-Shell", "1");
      res.end(
        `<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/_next/static/app.css"><div id="root"></div><script src="/_next/static/main-${version}.js"></script>`,
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const code = `import {createRoot} from 'react-dom/client';import {ReplicaEntry} from './src/components/replica/entry';import {PwaRegister} from './src/components/pwa-register';import {openReplica} from './src/client/replica/indexed-db';import {resourceFixture} from './tests/helpers/replica-resources';import {offlineOwnerKey} from './src/lib/offline-drafts';import {libraryRequest} from './src/client/replica/request';(async()=>{if(!localStorage.getItem('pwa-seeded')){const s=await openReplica('resources'),f=await resourceFixture(s);localStorage.setItem(offlineOwnerKey,'resources');localStorage.setItem('pwa-seeded','1');await fetch('/test-fixture/state',{method:'POST',body:JSON.stringify({epoch:(await s.checkpoint()).epoch})});f.repo.close();s.close();}window.queueLocal=async()=>{const r=await libraryRequest('/api/library',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:crypto.randomUUID(),type:'addNote',payload:{title:'오프라인에서 쓴 글',content:'앱을 업데이트해도 보관할 나의 생각',kind:'thought'}})});if(!r.ok)throw Error((await r.json()).error);return r.json();};window.pending=async()=>{const s=await openReplica('resources');try{return (await s.listOutbox()).length;}finally{s.close();}};createRoot(document.getElementById('root')).render(<><PwaRegister/><ReplicaEntry available={true} today="2026-10-17"/></>);})();`;
  bundle = (
    await build({
      stdin: { contents: code, loader: "tsx", resolveDir: process.cwd() },
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      jsx: "automatic",
      define: {
        "process.env.NODE_ENV": '"production"',
        "import.meta.url": JSON.stringify(
          origin + "/_next/static/main-pwa-v1.js",
        ),
      },
    })
  ).outputFiles[0].text;
  worker = (
    await build({
      entryPoints: ["src/client/replica/search-worker.ts"],
      bundle: true,
      write: false,
      platform: "browser",
      format: "esm",
    })
  ).outputFiles[0].text;
  css = await readFile("src/app/globals.css", "utf8");
  sw = await readFile("public/sw.js", "utf8");
});
test.beforeEach(() => {
  version = "pwa-v1";
  owner = "resources";
  epoch = "";
});
test.afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
});
test("starts the full app offline without Background Sync, preserves drafts through waiting updates and hides the old library after logout", async ({
  page,
  context,
}) => {
  test.setTimeout(60000);
  await page.addInitScript(() => {
    delete (window as any).SyncManager;
  });
  await page.goto(origin);
  await expect(page.locator(".workspace")).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const keys = await caches.keys();
        for (const key of keys) {
          const cache = await caches.open(key);
          if (await cache.match("/")) return true;
        }
        return false;
      }),
    )
    .toBe(true);
  await page.clock.install({ time: new Date("2026-10-18T01:00:00Z") });
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator(".workspace")).toBeVisible();
  await expect(page.locator(".page-heading time")).toContainText("2026.10.18");
  await page.evaluate(async () => {
    await (window as any).queueLocal();
  });
  await expect(page.locator(".workspace")).toContainText("오프라인에서 쓴 글");
  expect(await page.evaluate(() => (window as any).pending())).toBe(1);
  await page.reload();
  await expect(page.locator(".workspace")).toContainText("오프라인에서 쓴 글");
  expect(await page.evaluate(() => (window as any).pending())).toBe(1);
  const privateCaches = await page.evaluate(async () => {
    const found = [];
    for (const key of await caches.keys())
      for (const request of await (await caches.open(key)).keys())
        if (new URL(request.url).pathname.startsWith("/api/"))
          found.push(request.url);
    return found;
  });
  expect(privateCaches).toEqual([]);
  await context.setOffline(false);
  version = "pwa-v2";
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/sw.js?build=pwa-v2", {
      scope: "/",
      updateViaCache: "none",
    });
  });
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          !!(await navigator.serviceWorker.getRegistration("/"))?.waiting,
      ),
    )
    .toBe(true);
  expect(await page.evaluate(() => (window as any).appBuild)).toBe("pwa-v1");
  expect(await page.evaluate(() => (window as any).pending())).toBe(1);
  const second = await context.newPage();
  await second.goto(origin);
  await expect(second.locator(".workspace")).toBeVisible();
  owner = "different-account";
  await second.evaluate(() =>
    localStorage.removeItem("knowledge-library-offline-owner:v1"),
  );
  await expect(
    page.getByRole("button", { name: "Google 계정으로 시작하기", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".workspace")).toHaveCount(0);
  await second.close();
  await context.setOffline(true);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Google 계정으로 시작하기", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".workspace")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).pending())).toBe(1);
});
test("keeps an open input and its pending edits when another tab upgrades the device database", async ({
  page,
}) => {
  await page.goto(origin);
  await expect(page.locator(".workspace")).toBeVisible();
  await page.evaluate(() => (window as any).queueLocal());
  await page.getByRole("button", { name: "새 기록", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "새로운 기록", exact: true });
  await dialog
    .getByRole("textbox", { name: "내용", exact: true })
    .fill("업데이트 전에 입력하던 문장");
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const r = indexedDB.open("knowledge-library-replica", 2);
        r.onsuccess = () => {
          r.result.close();
          resolve();
        };
        r.onerror = () => reject(r.error);
      }),
  );
  await expect(
    page.getByText(
      "기기 자료는 유지됩니다. 입력을 보관한 뒤 최신 버전으로 서재를 다시 열어 주세요.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    dialog.getByRole("textbox", { name: "내용", exact: true }),
  ).toHaveValue("업데이트 전에 입력하던 문장");
  const count = await page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const r = indexedDB.open("knowledge-library-replica", 2);
        r.onsuccess = () => {
          const db = r.result,
            req = db
              .transaction("outbox", "readonly")
              .objectStore("outbox")
              .count();
          req.onsuccess = () => {
            resolve(req.result);
            db.close();
          };
        };
        r.onerror = () => reject(r.error);
      }),
  );
  expect(count).toBe(1);
});
