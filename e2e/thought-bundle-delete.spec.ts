import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { randomUUID } from "node:crypto";
import { sharedBoxSummaries } from "../src/lib/shared-thought-boxes";

let script: string;
test.beforeAll(async () => {
  script = (
    await build({
      stdin: {
        contents: `import{createRoot}from'react-dom/client';import{ThoughtBoxes}from'./src/components/memo-box/thought-boxes';createRoot(document.getElementById('root')).render(<ThoughtBoxes onOpen={()=>{}}/>);`,
        resolveDir: process.cwd(),
        loader: "tsx",
      },
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
    })
  ).outputFiles[0].text;
});

test("memo box deletes the canonical thought bundle while its original memo remains", async ({
  page,
}) => {
  const noteId = randomUUID(),
    id = randomUUID();
  const source = {
    notes: [
      { id: noteId, title: "원문 제목", content: "남아 있는 원문", tags: [] },
    ],
    books: [],
    topics: [],
    memberships: [],
    connections: [],
    bundleLinks: [],
    bundles: [
      {
        id,
        title: "삭제할 생각묶음",
        description: "정리",
        note_ids: [noteId],
        version: 1,
        archived_at: null as string | null,
      },
    ],
  };
  const calls: any[] = [];
  await page.route("**/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/whiteboard") return route.fulfill({ json: source });
    if (path === "/api/thought-boxes")
      return route.fulfill({
        json: {
          items: sharedBoxSummaries(source.bundles),
          pendingLegacy: false,
        },
      });
    if (path === "/api/knowledge") {
      const c = route.request().postDataJSON();
      calls.push(c);
      if (
        c.type === "archiveMemoBundle" &&
        c.payload.id === id &&
        c.payload.expectedVersion === 1
      ) {
        Object.assign(source.bundles[0], {
          archived_at: new Date().toISOString(),
          version: 2,
        });
        return route.fulfill({ json: { id, version: 2 } });
      }
      return route.fulfill({
        status: 400,
        json: { error: "잘못된 삭제 요청" },
      });
    }
    return route.fulfill({
      contentType: "text/html",
      body: '<html><div id="root"></div></html>',
    });
  });
  await page.goto("https://delete.test/");
  await page.addScriptTag({ content: script, type: "module" });
  await page.getByRole("button", { name: /^삭제할 생각묶음/ }).click();
  await expect(page.getByText("남아 있는 원문", { exact: true })).toBeVisible();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "삭제", exact: true }).click();
  expect(calls).toHaveLength(0);
  await expect(
    page.getByRole("button", { name: /^삭제할 생각묶음/ }),
  ).toHaveCount(1);
  page.once("dialog", (dialog) => {
    expect(dialog.message()).toContain("삭제할 생각묶음");
    expect(dialog.message()).toContain("메모 원문은 유지됩니다");
    return dialog.accept();
  });
  await page
    .getByRole("button", { name: "삭제", exact: true })
    .click({ timeout: 5000 });
  await expect(
    page.getByRole("button", { name: /^삭제할 생각묶음/ }),
  ).toHaveCount(0);
  await expect(
    page.getByText("생각묶음을 선택하면 원문과 정리를 볼 수 있습니다.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    type: "archiveMemoBundle",
    payload: { id, expectedVersion: 1 },
  });
  expect(source.notes).toEqual([
    { id: noteId, title: "원문 제목", content: "남아 있는 원문", tags: [] },
  ]);
});
