import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { emptyBoard } from "../src/lib/whiteboard";

let bundle: string;
test.beforeAll(async () => {
  bundle = (
    await build({
      stdin: {
        contents: `import {createRoot} from 'react-dom/client';import {MemoBox} from './src/components/memo-box/panel';createRoot(document.getElementById('root')).render(<MemoBox library={window.fixture.library} ownerId="topic-test" onOpen={(kind,id)=>window.opened={kind,id}} onNewNote={context=>window.created=context}/>);`,
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

async function mount(page: Page, savedTab = "topics") {
  const topics = ["공감", "경계"].map((name) => ({
      id: crypto.randomUUID(),
      name,
      version: 3,
      description: "주제 설명",
      aliases: [],
      parentId: null,
      kdcCodes: [],
      confirmed: true,
    })),
    notes = ["첫 메모", "둘째 메모"].map((title) => ({
      id: crypto.randomUUID(),
      title,
      content: title + "의 원문을 그대로 보존합니다",
      bookId: null,
      kind: "thought",
      page: null,
      tags: [],
      version: 1,
      createdAt: "2026-10-28T00:00:00Z",
      updatedAt: "2026-10-28T00:00:00Z",
    })),
    source = {
      board: {
        id: crypto.randomUUID(),
        version: 7,
        data: {
          ...emptyBoard(),
          links: [
            {
              source: "topic:" + topics[0].id,
              target: "topic:" + topics[1].id,
            },
          ],
        },
      },
      books: [],
      topics,
      notes,
      memberships: notes.map((n, i) => ({
        topicId: topics[i].id,
        sourceKind: "note",
        sourceId: n.id,
        status: "accepted",
      })),
      connections: [
        {
          id: crypto.randomUUID(),
          source_kind: "note",
          target_kind: "note",
          source_id: notes[0].id,
          target_id: notes[1].id,
          status: "accepted",
          relation: "related",
          reason: "메모에서 발견한 연결",
          version: 4,
        },
      ],
      topicLinks: [
        {
          id: crypto.randomUUID(),
          sourceTopicId: topics[0].id,
          targetTopicId: topics[1].id,
          status: "accepted",
          version: 3,
        },
      ],
    },
    commands: { path: string; type: string; payload: any }[] = [];
  await page.route("https://topic.test/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "POST") {
      const command = route.request().postDataJSON(),
        p = command.payload;
      commands.push({ path, ...command });
      if (command.type === "decideTopicLink") {
        const link = source.topicLinks.find((l) => l.id === p.id)!;
        if (p.expectedVersion !== link.version)
          return route.fulfill({
            status: 409,
            json: { error: "다른 곳에서 변경되었습니다" },
          });
        link.status = p.status;
        link.version++;
      }
      if (command.type === "editConnection") {
        const edge = source.connections.find((c) => c.id === p.id)!;
        if (p.expectedVersion !== edge.version)
          return route.fulfill({
            status: 409,
            json: { error: "다른 곳에서 변경되었습니다" },
          });
        edge.status = p.status;
        edge.version++;
      }
      if (command.type === "saveWhiteboard") {
        if (
          p.boardId !== source.board.id ||
          p.expectedVersion !== source.board.version
        )
          return route.fulfill({
            status: 409,
            json: { error: "다른 보드입니다" },
          });
        source.board.data = p.data;
        source.board.version++;
      }
      return route.fulfill({
        json: { id: p.id ?? source.board.id, version: 8 },
      });
    }
    if (path === "/api/whiteboard") return route.fulfill({ json: source });
    if (path === "/api/note-topics")
      return route.fulfill({ json: { topics, memberships: [] } });
    if (path === "/api/thought-map")
      return route.fulfill({
        json: {
          topics,
          topicLinks: source.topicLinks,
          memberships: [],
          notes: [],
          candidates: [],
          feedback: [],
          archivedTopics: [],
        },
      });
    if (path.startsWith("/api/"))
      return route.fulfill({
        json: {
          items: [],
          total: 0,
          requests: [],
          policy: {},
          usage: [],
          workers: [],
        },
      });
    return route.fulfill({
      contentType: "text/html",
      body: '<html lang="ko"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>',
    });
  });
  await page.goto("https://topic.test/");
  await page.evaluate(
    ({ notes, savedTab }) => {
      localStorage.setItem("library:memo-box-tab:topic-test", savedTab);
      (window as any).fixture = {
        library: { books: [], notes, cycles: [], catalog: { total: 0 } },
      };
    },
    { notes, savedTab },
  );
  await page.addStyleTag({ path: "src/app/globals.css" });
  await page.addScriptTag({ content: bundle });
  return { source, commands, notes, topics };
}

test("connected topics use a compact selectable list with a separate detail panel", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mount(page);
  const list = page.locator(".memo-topic-list"),
    detail = page.locator(".memo-topic-detail");
  await expect(list.getByRole("button")).toHaveCount(1);
  await expect(detail.getByRole("heading", { level: 3 })).toHaveCount(0);
  await list.getByRole("button").click();
  await expect(detail.getByRole("heading", { level: 3 })).toBeVisible();
  const left = (await list.boundingBox())!,
    right = (await detail.boundingBox())!;
  expect(left.x + left.width).toBeLessThan(right.x);
  await detail.getByRole("button", { name: "두 주제에 기록 남기기" }).click();
  expect(
    await page.evaluate(() => (window as any).created.topicIds),
  ).toHaveLength(2);
});

test("disconnects each actual source with its version and preserves the original notes", async ({
  page,
}) => {
  const f = await mount(page),
    list = page.locator(".memo-topic-list"),
    detail = page.locator(".memo-topic-detail");
  await list.getByRole("button").click();
  await detail
    .getByRole("button", { name: "화이트보드 연결 끊기", exact: true })
    .click();
  await expect.poll(() => f.source.board.data.links.length).toBe(0);
  await expect(list.getByRole("button")).toHaveCount(1);
  await detail
    .getByRole("button", { name: "주제 연결 끊기", exact: true })
    .click();
  await expect.poll(() => f.source.topicLinks[0].status).toBe("rejected");
  await expect(list.getByRole("button")).toHaveCount(1);
  await detail
    .getByRole("button", { name: "메모 연결 끊기", exact: true })
    .click();
  await expect(list.getByRole("button")).toHaveCount(0);
  expect(f.commands).toMatchObject([
    {
      path: "/api/knowledge",
      type: "saveWhiteboard",
      payload: { boardId: f.source.board.id, expectedVersion: 7 },
    },
    {
      path: "/api/thought-map",
      type: "decideTopicLink",
      payload: {
        id: f.source.topicLinks[0].id,
        expectedVersion: 3,
        status: "rejected",
      },
    },
    {
      path: "/api/knowledge",
      type: "editConnection",
      payload: {
        id: f.source.connections[0].id,
        expectedVersion: 4,
        status: "rejected",
        relation: "related",
        reason: "메모에서 발견한 연결",
      },
    },
  ]);
  expect(f.notes.map((note) => note.content)).toEqual([
    "첫 메모의 원문을 그대로 보존합니다",
    "둘째 메모의 원문을 그대로 보존합니다",
  ]);
});

test("selected topic details fit a narrow screen and expose related memo text", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mount(page);
  await page.locator(".memo-topic-list").getByRole("button").click();
  await page
    .locator(".memo-topic-detail")
    .locator(".memo-group-note summary")
    .first()
    .click();
  await expect(
    page.getByText("첫 메모의 원문을 그대로 보존합니다", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("a saved legacy writing tab falls back to My Records and has no nested writing entry", async ({
  page,
}) => {
  await mount(page, "writing");
  const tabs = page.locator(".memo-box > .knowledge-tabs");
  await expect(tabs.getByRole("button")).toHaveText([
    "내 기록",
    "연결된 메모",
    "연결된 주제",
  ]);
  await expect(tabs.locator("button.primary")).toHaveText("내 기록");
});
