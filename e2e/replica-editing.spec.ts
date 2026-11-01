import { test, expect } from "@playwright/test";
import { build } from "esbuild";
let bundle: string, worker: string;
test.beforeAll(async () => {
  // The former top-level notes view was consolidated into the memo box. Home
  // still opens the same real memo editor and is a supported initial route.
  const code = `import {createRoot} from 'react-dom/client';import {LibraryApp} from './src/components/library-app';import {ReplicaProvider} from './src/components/replica/provider';import {createLibraryRuntime} from './src/client/replica/runtime';import {openReplica} from './src/client/replica/indexed-db';import {resourceFixture} from './tests/helpers/replica-resources';(async()=>{const s=await openReplica('resources');if(!localStorage.getItem('seeded')){const f=await resourceFixture(s);localStorage.setItem('seeded','1');f.repo.close();}const runtime=createLibraryRuntime('resources',s,await s.checkpoint());window.runtime=runtime;createRoot(document.getElementById('root')).render(<ReplicaProvider runtime={runtime}><LibraryApp initial={await runtime.repository.overview()} ownerId="resources" today="2026-10-17" initialView="home"/></ReplicaProvider>);})();`;
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
        "import.meta.url": '"https://edit.test/assets/main.js"',
      },
    })
  ).outputFiles[0].text;
  worker = (
    await build({
      entryPoints: ["src/client/replica/search-worker.ts"],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
    })
  ).outputFiles[0].text;
});
test("edits a note twice through the real form offline and retains the text and persistent send queue after reload", async ({
  page,
}) => {
  let businessWrites = 0;
  await page.route("https://edit.test/**", (r) => {
    const path = new URL(r.request().url()).pathname;
    if (path.startsWith("/api/")) {
      if (r.request().method() === "POST") businessWrites++;
      return r.abort();
    }
    if (path.endsWith("search-worker.ts"))
      return r.fulfill({ contentType: "application/javascript", body: worker });
    if (path === "/main.js")
      return r.fulfill({ contentType: "application/javascript", body: bundle });
    return r.fulfill({
      contentType: "text/html",
      body: '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script src="/main.js"></script>',
    });
  });
  await page.goto("https://edit.test/");
  for (const content of ["오프라인 첫 수정", "오프라인 최종 수정"]) {
    await page.locator(".notes-grid .note-card > p").click();
    const dialog = page.getByRole("dialog", { name: "기록 수정", exact: true });
    await dialog
      .getByRole("textbox", { name: "내용", exact: true })
      .fill(content);
    await dialog.getByRole("button", { name: "저장하기", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.locator(".notes-grid")).toContainText(content);
  }
  await page.reload();
  await expect(page.locator(".notes-grid")).toContainText("오프라인 최종 수정");
  expect(
    await page.evaluate(
      async () =>
        await (window as any).runtime.storage
          .listOutbox()
          .then((e: any[]) => e.length),
    ),
  ).toBe(2);
  expect(businessWrites).toBe(0);
});
