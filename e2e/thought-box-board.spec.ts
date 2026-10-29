import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { emptyBoard, WHITEBOARD_ID } from "../src/lib/whiteboard";
import {
  addThoughtBox,
  putBoxNotes,
  listThoughtBoxes,
} from "../src/lib/thought-boxes";
let script: string, css: string;
test.beforeAll(async () => {
  script = (
    await build({
      stdin: {
        contents: `import{createRoot}from'react-dom/client';import{WhiteboardPanel}from'./src/components/whiteboard/panel';createRoot(document.getElementById('root')).render(<WhiteboardPanel library={{notes:window.source.notes,books:[],cycles:[],revisions:[]}} ownerId='test' onOpen={()=>{}} writingTitle={window.writing?'테스트 글감':undefined}/>);`,
        resolveDir: process.cwd(),
        loader: "tsx",
      },
      bundle: true,
      write: false,
      platform: "browser",
      format: "esm",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
    })
  ).outputFiles[0].text;
  css = await readFile("src/app/globals.css", "utf8");
});
async function setup(page: any, writing = false, withRemote = false) {
  const ids = Array.from({ length: 4 }, () => crypto.randomUUID());
  const source: any = {
    notes: ids.map((id, i) => ({
      id,
      title: `메모 ${i + 1}`,
      content: `원문 ${i + 1}`,
      tags: [],
    })),
    books: [],
    topics: [],
    memberships: [],
    topicLinks: [],
    connections: [
      {
        id: crypto.randomUUID(),
        source_kind: "note",
        target_kind: "note",
        source_id: ids[2],
        target_id: ids[3],
        status: "accepted",
        relation: "related",
        reason: "연결 이유",
        version: 1,
      },
    ],
    bundles: [],
    bundleLinks: [],
  };
  let board = addThoughtBox(emptyBoard(), crypto.randomUUID(), "기존 상자");
  board = putBoxNotes(board, board.writing!.chapters[0].id, [ids[0]], source);
  source.board = { id: WHITEBOARD_ID, data: board, version: 1 };
  const remoteId = crypto.randomUUID(),
    remoteChapterId = crypto.randomUUID();
  const remote = {
    ...source,
    board: {
      id: remoteId,
      data: putBoxNotes(
        addThoughtBox(emptyBoard(), remoteChapterId, "다른 글감 상자"),
        remoteChapterId,
        [ids[1]],
        source,
      ),
      version: 3,
    },
  };
  let saves = 0;
  await page.route("**/*", async (route: any) => {
    const url = route.request().url();
    if (url.includes("/api/thought-boxes"))
      return route.fulfill({
        json: {
          items: listThoughtBoxes(
            withRemote ? [source.board, remote.board] : [source.board],
            withRemote ? [{ id: remoteId, title: "다른 글감" }] : [],
          ),
        },
      });
    if (url.includes("/api/whiteboard"))
      return route.fulfill({ json: url.includes(remoteId) ? remote : source });
    if (url.endsWith("/api/knowledge")) {
      const { type, payload } = route.request().postDataJSON();
      expect(type).toBe("saveWhiteboard");
      saves++;
      source.board = {
        ...source.board,
        data: payload.data,
        version: source.board.version + 1,
      };
      return route.fulfill({ json: { version: source.board.version } });
    }
    return route.fulfill({
      contentType: "text/html",
      body: '<html><body><div id="root"></div></body></html>',
    });
  });
  await page.goto("http://127.0.0.1:3000/box-fixture");
  await page.addStyleTag({ content: css });
  await page.evaluate(
    ({ source, writing }: any) => {
      Object.assign(window, { source, writing });
    },
    { source, writing },
  );
  await page.addScriptTag({ content: script, type: "module" });
  await expect(page.locator(".writing-chapter")).toHaveCount(1);
  return { source, remote, ids, saves: () => saves };
}
test("ordinary whiteboard creates titled thought boxes, contains a memo, and confirms deletion", async ({
  page,
}) => {
  const { source, ids } = await setup(page);
  await page.getByRole("button", { name: "상자 추가", exact: true }).click();
  await expect(page.locator(".writing-chapter")).toHaveCount(2);
  await page
    .locator(".writing-chapter")
    .last()
    .getByLabel("상자 제목")
    .fill("두 번째 생각");
  await page
    .getByRole("article", { name: "메모 메모 2", exact: true })
    .press("Enter");
  await page
    .locator(".writing-chapter")
    .last()
    .getByRole("button", { name: "선택 메모 담기" })
    .click();
  await expect
    .poll(() =>
      source.board.data.writing.chapters[1]?.items.flatMap(
        (x: any) => x.noteIds,
      ),
    )
    .toContain(ids[1]);
  page.once("dialog", (d) => d.dismiss());
  await page
    .locator(".writing-chapter")
    .last()
    .getByRole("button", { name: "상자 삭제" })
    .click();
  await expect(page.locator(".writing-chapter")).toHaveCount(2);
  page.once("dialog", (d) => d.accept());
  await page
    .locator(".writing-chapter")
    .last()
    .getByRole("button", { name: "상자 삭제" })
    .click();
  await expect(page.locator(".writing-chapter")).toHaveCount(1);
  expect(source.notes).toHaveLength(4);
  await page
    .getByRole("button", { name: "메모 1 상자에서 빼기", exact: true })
    .click();
  await expect(
    page.locator(`[data-chapter-note-id][data-note-id="${ids[0]}"]`),
  ).toHaveCount(0);
  expect(source.notes).toHaveLength(4);
});
test("connection viewing preserves pinned content and coordinates and searches affect only loose notes", async ({
  page,
}) => {
  const { source, ids, saves } = await setup(page, true);
  await page.getByRole("button", { name: "상자 추가", exact: true }).waitFor();
  const pinned = page.locator(
    `[data-chapter-note-id][data-note-id="${ids[0]}"]`,
  );
  const position = await pinned.getAttribute("style");
  const original = structuredClone(source.board.data.writing.chapters);
  await page.locator(".wb-connection-list").locator("summary").click();
  await expect(page.locator(".wb-entry-badge")).toHaveText(["메", "생"]);
  await page
    .locator(".wb-connection-actions")
    .getByRole("button", { name: "전체보기", exact: true })
    .click();
  await expect(pinned).toBeVisible();
  expect(await pinned.getAttribute("style")).toBe(position);
  expect(source.board.data.writing.chapters).toEqual(original);
  expect(saves()).toBe(0);
  await page.getByLabel("메모 제목·내용 검색").fill("메모 2");
  await page
    .locator(".wb-search")
    .getByRole("button", { name: "검색", exact: true })
    .click();
  await expect(pinned).toBeVisible();
  await expect(
    page.getByRole("article", { name: "메모 메모 2", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("article", { name: "메모 메모 3", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel("메모 1 순서")).toBeVisible();
  await page.getByLabel("메모 1 순서").fill("7");
  await expect
    .poll(() => source.board.data.writing.chapters[0].items[0].order)
    .toBe(7);
  await expect(page.getByText("자료 순서", { exact: false })).toHaveCount(0);
});

test("imports a thought box beside current boxes once without changing source or pinned positions", async ({
  page,
}) => {
  const { source, remote, ids } = await setup(page, true, true);
  const saved = structuredClone(source.board.data.writing.chapters[0]);
  const origin = structuredClone(remote.board);
  const pinned = page.locator(
    `[data-chapter-note-id][data-note-id="${ids[0]}"]`,
  );
  const position = await pinned.getAttribute("style");
  await page.locator(".wb-connection-list summary").click();
  const load = page.getByRole("button", { name: /다른 글감 상자 다른 글감/ });
  await load.click();
  await expect(page.locator(".writing-chapter")).toHaveCount(2);
  expect(await pinned.getAttribute("style")).toBe(position);
  await expect.poll(() => source.board.data.writing.chapters.length).toBe(2);
  expect(source.board.data.writing.chapters[0]).toEqual(saved);
  expect(source.board.data.writing.chapters[1].x).toBeGreaterThan(
    saved.x + saved.width,
  );
  expect(
    source.board.data.writing.chapters[1].items.flatMap((i: any) => i.noteIds),
  ).toContain(ids[1]);
  expect(remote.board).toEqual(origin);
  await load.click();
  await expect(page.locator(".writing-chapter")).toHaveCount(2);
});
