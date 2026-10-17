import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { emptyLibrary } from "../src/lib/domain";
for (const fallback of [false, true])
  test(`does not restore a previous account after delayed reading overlay (${fallback ? "retry" : "first overview"})`, async ({
    page,
  }) => {
    const runtimePath =
      process.cwd().replaceAll("\\", "/") + "/src/client/replica/runtime.ts";
    const js = (
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
          "import.meta.url": '"https://fallback.test/app.js"',
        },
        plugins: [
          {
            name: "delay-real-reading-overlay",
            setup(b) {
              b.onResolve({ filter: /\/replica\/runtime$/ }, () => ({
                path: "delayed-runtime",
                namespace: "test-delay",
              }));
              b.onLoad({ filter: /.*/, namespace: "test-delay" }, () => ({
                loader: "ts",
                resolveDir: process.cwd(),
                contents: `import{createLibraryRuntime as original,verifiedSyncOwner}from ${JSON.stringify(runtimePath)};export{verifiedSyncOwner};export function createLibraryRuntime(...args){const r=original(...args);return{...r,async withPendingReading(data){const result=await r.withPendingReading(data);document.body.dataset.overlayWaiting='1';await new Promise(resolve=>{window.releaseReading=resolve});return result}}}`,
              }));
            },
          },
        ],
      })
    ).outputFiles[0].text;
    await page.route("https://fallback.test/", (r) =>
      r.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
    );
    await page.route("https://fallback.test/api/**", (r) =>
      r.fulfill({ status: 503, json: { error: "temporarily unavailable" } }),
    );
    await page.route("https://fallback.test/api/sync/session", (r) =>
      r.fulfill({ json: { ownerId: "account-A" } }),
    );
    let reads = 0;
    await page.route("https://fallback.test/api/library", (r) =>
      ++reads === 1 && fallback
        ? r.fulfill({ status: 503, json: { error: "retry" } })
        : r.fulfill({ json: emptyLibrary() }),
    );
    await page.goto("https://fallback.test/");
    await page.addScriptTag({ content: js });
    await expect(page.locator("body")).toHaveAttribute(
      "data-overlay-waiting",
      "1",
    );
    await page.evaluate(() => {
      localStorage.setItem("knowledge-library-offline-owner:v1", "account-B");
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "knowledge-library-offline-owner:v1",
          newValue: "account-B",
        }),
      );
    });
    await expect(
      page.getByRole("button", {
        name: "Google 계정으로 시작하기",
        exact: true,
      }),
    ).toBeVisible();
    await page.evaluate(async () => {
      (window as any).releaseReading();
      await new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(r)),
      );
    });
    await expect(page.locator(".workspace")).toHaveCount(0);
    await expect(
      page.getByRole("button", {
        name: "Google 계정으로 시작하기",
        exact: true,
      }),
    ).toBeVisible();
  });

test("keeps an opened device store attached when only the initial online overview fails once", async ({
  page,
}) => {
  const js = (
    await build({
      stdin: {
        contents: `import{createRoot}from'react-dom/client';import{ReplicaEntry}from'./src/components/replica/entry';createRoot(document.getElementById('root')).render(<ReplicaEntry available={true}/>);`,
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
        "import.meta.url": '"https://fallback.test/app.js"',
      },
    })
  ).outputFiles[0].text;
  await page.route("https://fallback.test/", (r) =>
    r.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
  );
  await page.route("https://fallback.test/api/**", (r) =>
    r.fulfill({ status: 503, json: { error: "temporarily unavailable" } }),
  );
  await page.route("https://fallback.test/api/sync/session", (r) =>
    r.fulfill({ json: { ownerId: "online-owner" } }),
  );
  await page.route("https://fallback.test/api/auth/get-session", (r) =>
    r.fulfill({
      json: { user: { id: "online-owner" }, session: { id: "fixture" } },
    }),
  );
  let reads = 0;
  await page.route("https://fallback.test/api/library", (r) =>
    ++reads === 1
      ? r.fulfill({
          status: 503,
          json: { error: "overview temporarily unavailable" },
        })
      : r.fulfill({ json: emptyLibrary() }),
  );
  await page.goto("https://fallback.test/");
  await page.addScriptTag({ content: js });
  await expect(page.locator(".workspace")).toBeVisible();
  await expect(
    page.getByText(
      "기기 저장소를 사용할 수 없어 온라인으로 표시합니다. 기기 자료는 유지됩니다.",
    ),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "기기 저장·동기화", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "동기화 재개", exact: true }),
  ).toBeEnabled();
});
test("keeps the verified online library usable when IndexedDB cannot open, without claiming a full device copy", async ({
  page,
}) => {
  const js = (
    await build({
      stdin: {
        contents: `import{createRoot}from'react-dom/client';import{ReplicaEntry}from'./src/components/replica/entry';createRoot(document.getElementById('root')).render(<ReplicaEntry available={true}/>);`,
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
        "import.meta.url": '"https://fallback.test/app.js"',
      },
    })
  ).outputFiles[0].text;
  await page.addInitScript(() => {
    Object.defineProperty(window, "indexedDB", {
      value: {
        open() {
          throw new DOMException("Storage unavailable", "SecurityError");
        },
      },
    });
  });
  await page.route("https://fallback.test/", (r) =>
    r.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
  );
  await page.route("https://fallback.test/api/**", (r) =>
    r.fulfill({ status: 503, json: { error: "not in fixture" } }),
  );
  await page.route("https://fallback.test/api/sync/session", (r) =>
    r.fulfill({ json: { ownerId: "online-owner" } }),
  );
  await page.route("https://fallback.test/api/library", (r) =>
    r.fulfill({ json: emptyLibrary() }),
  );
  await page.goto("https://fallback.test/");
  await page.addScriptTag({ content: js });
  await expect(page.locator(".workspace")).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("온라인");
  await expect(page.getByText("동기화 완료", { exact: true })).toHaveCount(0);
});
