import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { randomUUID } from "node:crypto";
import {
  referenceThoughtBox,
  sharedBoxSummaries,
} from "../src/lib/shared-thought-boxes";
import { emptyBoard, WHITEBOARD_ID } from "../src/lib/whiteboard";

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

test("writing-board box delete archives the canonical bundle and removes it from connection management", async ({
  page,
}) => {
  const source: any = {
    board: null,
    notes: [
      {
        id: randomUUID(),
        title: "보존할 원문",
        content: "원문은 삭제하지 않음",
        bookId: null,
        tags: [],
        kind: "thought",
        page: null,
        version: 1,
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
      },
    ],
    books: [],
    topics: [],
    memberships: [],
    connections: [],
    bundleLinks: [],
    bundles: [],
  };
  const id = randomUUID();
  source.bundles = [
    {
      id,
      title: "공통 생각묶음",
      description: "설명",
      note_ids: [source.notes[0].id],
      version: 1,
      archived_at: null,
    },
  ];
  const board = referenceThoughtBox(emptyBoard(), source.bundles[0], source);
  source.board = { id: WHITEBOARD_ID, version: 1, data: board };
  const calls: any[] = [];
  const js = (
    await build({
      stdin: {
        contents: `import{createRoot}from'react-dom/client';import{WhiteboardPanel}from'./src/components/whiteboard/panel';createRoot(document.getElementById('root')).render(<WhiteboardPanel library={window.fixture} ownerId="writing-delete-fixture" boardId="00000000-0000-4000-8000-000000000001" writingTitle="글감묶기" onOpen={()=>{}}/>);`,
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
  await page.route("https://writing-delete.test/**", (route) => {
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
      const command = route.request().postDataJSON();
      calls.push(command);
      if (command.type === "archiveMemoBundle" && command.payload.id === id) {
        source.bundles[0].archived_at = new Date().toISOString();
        source.bundles[0].version = 2;
        return route.fulfill({ json: { id, version: 2 } });
      }
      if (command.type === "saveWhiteboard") {
        source.board = {
          id: WHITEBOARD_ID,
          version: source.board.version + 1,
          data: command.payload.data,
        };
        return route.fulfill({
          json: { id: WHITEBOARD_ID, version: source.board.version },
        });
      }
      return route.fulfill({
        status: 400,
        json: { error: "Unexpected command" },
      });
    }
    return route.fulfill({
      contentType: "text/html",
      body: '<html><div id="root"></div></html>',
    });
  });
  await page.goto("https://writing-delete.test/");
  await page.evaluate((fixture) => ((window as any).fixture = fixture), {
    notes: source.notes,
    books: [],
    cycles: [],
  });
  await page.addScriptTag({ content: js, type: "module" });
  await expect(
    page.getByRole("button", { name: "상자 삭제" }).first(),
  ).toBeVisible();
  await page.locator(".wb-connection-counts").click();
  await expect(page.locator(".wb-connection-list")).toContainText(
    "공통 생각묶음",
  );
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "상자 삭제" }).first().click();
  await expect
    .poll(() =>
      calls.some((c) => c.type === "archiveMemoBundle" && c.payload.id === id),
    )
    .toBe(true);
  await expect(page.locator(".wb-connection-list")).not.toContainText(
    "공통 생각묶음",
  );
  expect(source.notes).toHaveLength(1);
  expect(source.bundles[0].archived_at).toBeTruthy();
});
