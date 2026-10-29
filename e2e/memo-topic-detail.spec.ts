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
      format: "esm",
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
    if (path === "/api/note-tags") return route.fulfill({ json: [] });
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
  await page.addScriptTag({ content: bundle, type: "module" });
  return { source, commands, notes, topics };
}

test("legacy classification and board-topic connections remain stored without appearing as thought-bundle links", async ({
  page,
}) => {
  const f = await mount(page);
  await expect(
    page.getByRole("region", { name: "생각 묶음 관리" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "새 묶음 연결", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".thought-box-list > button")).toHaveCount(0);
  expect(f.source.board.data.links).toHaveLength(1);
  expect(f.source.topicLinks).toHaveLength(1);
  expect(f.source.connections).toHaveLength(1);
  expect(f.commands).toHaveLength(0);
});

test("a saved legacy writing tab falls back to My Records and has no nested writing entry", async ({
  page,
}) => {
  await mount(page, "writing");
  const tabs = page.locator(".memo-box > .knowledge-tabs");
  await expect(tabs.getByRole("button")).toHaveText([
    "내 기록",
    "연결된 메모",
    "생각 묶음",
  ]);
  await expect(tabs.locator("button.primary")).toHaveText("내 기록");
});
