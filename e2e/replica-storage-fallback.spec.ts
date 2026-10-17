import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { emptyLibrary } from "../src/lib/domain";
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
