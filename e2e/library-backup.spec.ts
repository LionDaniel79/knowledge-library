import { test, expect } from "@playwright/test";
import { build } from "esbuild";
let bundle: string;
test.beforeAll(async () => {
  bundle = (
    await build({
      stdin: {
        contents: `import {createRoot} from 'react-dom/client'; import {BackupPanel} from './src/components/backup-panel'; createRoot(document.getElementById('root')).render(<BackupPanel onClose={()=>{}} onRestored={async()=>{}}/>);`,
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
});
for (const occupied of [false, true])
  test(`backup preview ${occupied ? "protects an existing library" : "requires explicit restore"}`, async ({
    page,
  }) => {
    let restores = 0;
    await page.route("https://library.test/api/backup", (route) => {
      const body = route.request().postDataJSON();
      if (body.action === "restore") {
        restores++;
        return route.fulfill({ json: { restored: true } });
      }
      return route.fulfill({
        json: {
          canRestore: !occupied,
          existingRecords: occupied ? 5 : 0,
          counts: {
            library_books: 1000,
            library_notes: 157,
            library_cycles: 419,
          },
          createdAt: "2026-10-14T00:00:00Z",
        },
      });
    });
    await page.route("https://library.test/", (r) =>
      r.fulfill({
        contentType: "text/html",
        body: '<html lang="ko"><div id="root"></div></html>',
      }),
    );
    await page.goto("https://library.test/");
    await page.addStyleTag({ path: "src/app/globals.css" });
    await page.addScriptTag({ content: bundle });
    await page.getByLabel("복원할 백업 파일").setInputFiles({
      name: "backup.json",
      mimeType: "application/json",
      buffer: Buffer.from('{"format":"knowledge-library-backup"}'),
    });
    await page.getByRole("button", { name: "백업 검사", exact: true }).click();
    await expect(page.getByText("도서 1,000건", { exact: true })).toBeVisible();
    expect(restores).toBe(0);
    const restore = page.getByRole("button", {
      name: "빈 서재에 복원",
      exact: true,
    });
    if (occupied) {
      await expect(restore).toBeDisabled();
      await expect(page.getByText(/기존 자료가 있어/)).toBeVisible();
    } else {
      await restore.click();
      await expect(
        page.getByText("복원을 마쳤습니다.", { exact: true }),
      ).toBeVisible();
      expect(restores).toBe(1);
    }
  });
