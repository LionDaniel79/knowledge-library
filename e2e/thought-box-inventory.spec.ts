import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { randomUUID } from "node:crypto";
import { emptyBoard, WHITEBOARD_ID, type Board } from "../src/lib/whiteboard";

let bundle: string;

test.beforeAll(async () => {
  bundle = (
    await build({
      stdin: {
        contents: `import{createRoot}from'react-dom/client';import{useState}from'react';import{MemoBox}from'./src/components/memo-box/panel';function App(){const[revision,setRevision]=useState(0);window.refreshInventory=()=>setRevision(v=>v+1);return <MemoBox library={window.fixture.library} ownerId="thought-box-fixture" revision={revision} onOpen={(kind,id)=>window.opened.push({kind,id})} onNewNote={()=>{}}/>}createRoot(document.getElementById('root')).render(<App/>);`,
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

async function mount(page: Page, savedTab = "bundles") {
  const notes = ["첫 원문", "둘째 원문"].map((title) => ({
    id: randomUUID(),
    title,
    content: `${title}을 빠짐없이 읽고 편집할 수 있다.\n두 번째 문단도 남는다.`,
    bookId: null,
    kind: "thought",
    page: null,
    tags: [],
    version: 1,
    createdAt: "2026-10-30",
    updatedAt: "2026-10-30",
  }));
  const makeChapter = (title: string, index: number) => ({
    id: randomUUID(),
    title,
    text: `${title}의 원래 정리`,
    order: index + 1,
    x: 24 + index * 820,
    y: 48,
    width: 760,
    height: 420,
    items: notes.map((note, i) => ({
      id: randomUUID(),
      order: i + 1,
      kind: "note" as const,
      label: note.title,
      noteIds: [note.id],
      groupIds: [],
    })),
  });
  const first = makeChapter("첫 상자", 0);
  const sibling = makeChapter("같은 보드의 다른 상자", 1);
  const other = makeChapter("글감의 상자", 0);
  const data: Board = {
    ...emptyBoard(),
    filter: {
      topics: [],
      tags: ["보존할 태그"],
      categories: [],
      books: [],
      q: "기존 검색",
    },
    positions: { ["note::" + notes[0].id]: { x: 91, y: 238 } },
    hiddenNoteIds: [randomUUID()],
    writing: {
      chapters: [first, sibling],
      viewport: { x: 85, y: 67, zoom: 0.7 },
    },
  };
  const original = structuredClone(data);
  const otherId = randomUUID();
  const boards = new Map([
    [WHITEBOARD_ID, { id: WHITEBOARD_ID, data, version: 6 }],
    [
      otherId,
      {
        id: otherId,
        data: { ...emptyBoard(), writing: { chapters: [other] } },
        version: 3,
      },
    ],
  ]);
  const source = {
    notes,
    books: [],
    topics: [],
    memberships: [],
    connections: [],
    topicLinks: [],
    bundles: [],
    bundleLinks: [],
  };
  const commands: any[] = [];
  const reads: string[] = [];
  const network = { failBoardRead: false };
  await page.route("https://library.test/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET") reads.push(url.pathname + url.search);
    if (url.pathname === "/api/thought-boxes")
      return route.fulfill({
        json: {
          items: [...boards.values()].flatMap((board) =>
            (board.data.writing?.chapters ?? []).map((chapter) => ({
              id: `${board.id}:${chapter.id}`,
              boardId: board.id,
              chapterId: chapter.id,
              boardTitle:
                board.id === WHITEBOARD_ID ? "화이트보드" : "글감 하나",
              title: chapter.title,
              order: chapter.order,
              noteCount: 2,
              boardVersion: board.version,
            })),
          ),
        },
      });
    if (url.pathname === "/api/whiteboard") {
      if (network.failBoardRead)
        return route.fulfill({
          status: 500,
          json: { error: "보드 조회가 잠시 중단되었습니다." },
        });
      return route.fulfill({
        json: {
          ...source,
          board: boards.get(url.searchParams.get("boardId") ?? WHITEBOARD_ID),
        },
      });
    }
    if (url.pathname === "/api/knowledge" && request.method() === "POST") {
      const command = request.postDataJSON();
      commands.push(command);
      if (command.type !== "saveWhiteboard")
        return route.fulfill({
          status: 400,
          json: { error: "예상하지 않은 변경입니다." },
        });
      const board = boards.get(command.payload.boardId)!;
      if (board.version !== command.payload.expectedVersion)
        return route.fulfill({
          status: 409,
          json: { error: "다른 기기에서 상자가 변경되었습니다." },
        });
      board.data = command.payload.data;
      board.version++;
      return route.fulfill({ json: { id: board.id, version: board.version } });
    }
    return route.fulfill({ json: {} });
  });
  await page.route("https://library.test/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>',
    }),
  );
  await page.goto("https://library.test/");
  await page.evaluate(
    ({ library, savedTab }) => {
      (window as any).fixture = { library };
      (window as any).opened = [];
      localStorage.setItem(
        "library:memo-box-tab:thought-box-fixture",
        savedTab,
      );
    },
    { library: { books: [], notes, cycles: [] }, savedTab },
  );
  await page.addStyleTag({ path: "src/app/globals.css" });
  await page.addScriptTag({ content: bundle, type: "module" });
  return {
    notes,
    first,
    sibling,
    other,
    otherId,
    boards,
    original,
    commands,
    reads,
    network,
  };
}

for (const width of [390, 1280])
  test(`inventory opens the original board box and saves only its edited fields at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mount(page);
    const list = page.locator(".thought-box-list");
    await expect(list.locator(":scope > button")).toHaveCount(3);
    expect(
      fixture.reads.filter((path) => path.startsWith("/api/whiteboard")),
    ).toHaveLength(0);
    await expect(
      page.getByText("생각 묶음을 선택하면 원문과 정리를 볼 수 있습니다.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "묶음 연결", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "생각 묶음으로 저장", exact: true }),
    ).toHaveCount(0);
    await list.getByRole("button").filter({ hasText: "1. 첫 상자" }).click();
    await expect(page.getByLabel("상자 제목", { exact: true })).toHaveValue(
      "첫 상자",
    );
    expect(fixture.reads).toContain(`/api/whiteboard?boardId=${WHITEBOARD_ID}`);
    await expect(page.locator(".thought-box-note").first()).toContainText(
      fixture.notes[0].content,
    );
    await page
      .getByRole("button", { name: "첫 원문 원본 메모 열기", exact: true })
      .click();
    expect(await page.evaluate(() => (window as any).opened)).toEqual([
      { kind: "note", id: fixture.notes[0].id },
    ]);
    await page.getByLabel("상자 제목", { exact: true }).fill("고친 상자");
    await page
      .getByLabel("상자 내용", { exact: true })
      .fill("내가 정리한 두 문단\n그대로 보존한다.");
    await page.getByLabel("상자 번호", { exact: true }).fill("4");
    await page
      .getByRole("spinbutton", { name: "첫 원문 순서", exact: true })
      .fill("7");
    await page
      .getByRole("button", { name: "상자 변경 저장", exact: true })
      .click();
    await expect.poll(() => fixture.commands.length).toBe(1);
    const saved = fixture.commands[0];
    expect(saved.type).toBe("saveWhiteboard");
    expect(saved.payload.boardId).toBe(WHITEBOARD_ID);
    expect(saved.payload.expectedVersion).toBe(6);
    expect(saved.payload.data).toEqual({
      ...fixture.original,
      writing: {
        ...fixture.original.writing,
        chapters: [
          {
            ...fixture.first,
            title: "고친 상자",
            text: "내가 정리한 두 문단\n그대로 보존한다.",
            order: 4,
            items: fixture.first.items.map((item, i) =>
              i ? item : { ...item, order: 7 },
            ),
          },
          fixture.sibling,
        ],
      },
    });
    await expect(page.getByRole("status")).toContainText(
      "상자 변경을 저장했습니다.",
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`thought-box-inventory-${width}.png`),
      fullPage: true,
    });
  });

test("remote changes and failed reads keep the draft and its original board version across selection", async ({
  page,
}) => {
  const fixture = await mount(page);
  const list = page.locator(".thought-box-list");
  await list.getByRole("button").filter({ hasText: "1. 첫 상자" }).click();
  const content = page.getByLabel("상자 내용", { exact: true });
  await content.fill("저장하지 않은 내 초안");
  const serverBoard = fixture.boards.get(WHITEBOARD_ID)!;
  serverBoard.version = 7;
  serverBoard.data.writing!.chapters[0].text = "다른 기기의 새 정리";
  await page.evaluate(() => (window as any).refreshInventory());
  await expect(page.getByRole("alert")).toContainText(
    "작성 중인 내용은 유지됩니다.",
  );
  await expect(content).toHaveValue("저장하지 않은 내 초안");
  await page
    .getByRole("button", { name: "상자 변경 저장", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "다른 기기에서 상자가 변경되었습니다.",
  );
  expect(fixture.commands[0].payload.expectedVersion).toBe(6);
  await list.getByRole("button").filter({ hasText: "1. 글감의 상자" }).click();
  await expect(page.getByLabel("상자 제목", { exact: true })).toHaveValue(
    "글감의 상자",
  );
  await list.getByRole("button").filter({ hasText: "1. 첫 상자" }).click();
  await expect(content).toHaveValue("저장하지 않은 내 초안");
  fixture.network.failBoardRead = true;
  await page.evaluate(() => (window as any).refreshInventory());
  await expect(page.getByRole("alert")).toContainText(
    "보드 조회가 잠시 중단되었습니다.",
  );
  await expect(content).toHaveValue("저장하지 않은 내 초안");
  expect(serverBoard.data.writing!.chapters[0].text).toBe(
    "다른 기기의 새 정리",
  );
  fixture.network.failBoardRead = false;
  serverBoard.data.positions["note::" + fixture.notes[0].id] = {
    x: 930,
    y: 480,
  };
  serverBoard.data.writing!.chapters[0].title = "다른 기기의 제목";
  serverBoard.data.writing!.chapters[1].text = "다른 상자의 최신 정리";
  const latest = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/whiteboard",
  );
  await page
    .getByRole("button", { name: "목록 새로고침", exact: true })
    .click();
  await latest;
  await page
    .getByRole("button", { name: "내 변경을 최신 보드에 합치기", exact: true })
    .click();
  await expect(content).toHaveValue("저장하지 않은 내 초안");
  await expect(page.getByLabel("상자 제목", { exact: true })).toHaveValue(
    "다른 기기의 제목",
  );
  await page
    .getByRole("button", { name: "상자 변경 저장", exact: true })
    .click();
  await expect.poll(() => fixture.commands.length).toBe(2);
  expect(fixture.commands[1].payload.expectedVersion).toBe(7);
  expect(serverBoard.data.writing!.chapters[0].text).toBe(
    "저장하지 않은 내 초안",
  );
  expect(serverBoard.data.writing!.chapters[0].title).toBe("다른 기기의 제목");
  expect(serverBoard.data.writing!.chapters[1].text).toBe(
    "다른 상자의 최신 정리",
  );
  expect(serverBoard.data.positions["note::" + fixture.notes[0].id]).toEqual({
    x: 930,
    y: 480,
  });
  await expect(page.getByRole("status")).toContainText(
    "상자 변경을 저장했습니다.",
  );
});

for (const removeAll of [false, true])
  test(`a box deleted in the latest board keeps its unfinished draft without recreating the deleted box${removeAll ? " with no boxes remaining" : ""}`, async ({
    page,
  }) => {
    const fixture = await mount(page);
    await page
      .locator(".thought-box-list")
      .getByRole("button")
      .filter({ hasText: "1. 첫 상자" })
      .click();
    const content = page.getByLabel("상자 내용", { exact: true });
    await content.fill("삭제 후에도 남길 내 초안");
    const serverBoard = fixture.boards.get(WHITEBOARD_ID)!;
    serverBoard.version = 7;
    if (removeAll) delete serverBoard.data.writing;
    else
      serverBoard.data.writing!.chapters = [
        serverBoard.data.writing!.chapters[1],
      ];
    await page.evaluate(() => (window as any).refreshInventory());
    await expect(
      page.getByRole("button", {
        name: "내 변경을 최신 보드에 합치기",
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole("button", {
        name: "내 변경을 최신 보드에 합치기",
        exact: true,
      })
      .click();
    await expect(page.getByRole("alert")).toContainText(
      "최신 보드에서 삭제되었습니다.",
    );
    await expect(content).toHaveValue("삭제 후에도 남길 내 초안");
    expect(fixture.commands).toHaveLength(0);
    if (removeAll) expect(serverBoard.data.writing).toBeUndefined();
    else expect(serverBoard.data.writing!.chapters).toHaveLength(1);
  });

test("merging after editing two boxes in one board keeps both drafts and unrelated remote changes", async ({
  page,
}) => {
  const fixture = await mount(page);
  const list = page.locator(".thought-box-list");
  await list.getByRole("button").filter({ hasText: "1. 첫 상자" }).click();
  await page.getByLabel("상자 내용", { exact: true }).fill("첫 상자의 내 초안");
  await list
    .getByRole("button")
    .filter({ hasText: "2. 같은 보드의 다른 상자" })
    .click();
  await page
    .getByLabel("상자 제목", { exact: true })
    .fill("둘째 상자의 내 제목");
  const serverBoard = fixture.boards.get(WHITEBOARD_ID)!;
  serverBoard.version = 7;
  serverBoard.data.writing!.chapters[0].x = 480;
  serverBoard.data.writing!.chapters[1].text = "둘째 상자의 다른 기기 정리";
  await page.evaluate(() => (window as any).refreshInventory());
  await page
    .getByRole("button", { name: "내 변경을 최신 보드에 합치기", exact: true })
    .click();
  await page
    .getByRole("button", { name: "상자 변경 저장", exact: true })
    .click();
  await expect.poll(() => fixture.commands.length).toBe(1);
  expect(serverBoard.data.writing!.chapters[0].text).toBe("첫 상자의 내 초안");
  expect(serverBoard.data.writing!.chapters[0].x).toBe(480);
  expect(serverBoard.data.writing!.chapters[1].title).toBe(
    "둘째 상자의 내 제목",
  );
  expect(serverBoard.data.writing!.chapters[1].text).toBe(
    "둘째 상자의 다른 기기 정리",
  );
});

test("the remembered bundle-connection tab migrates to the board-box inventory", async ({
  page,
}) => {
  await mount(page, "topics");
  await expect(
    page.locator(".memo-box > .knowledge-tabs button.primary"),
  ).toHaveText("생각 묶음");
  await expect(page.locator(".thought-box-list > button")).toHaveCount(3);
  expect(
    await page.evaluate(() =>
      localStorage.getItem("library:memo-box-tab:thought-box-fixture"),
    ),
  ).toBe("bundles");
});

test("visiting connected notes keeps the selected box draft, and a removed edited note blocks recovery without losing it", async ({
  page,
}) => {
  const fixture = await mount(page);
  await page
    .locator(".thought-box-list")
    .getByRole("button")
    .filter({ hasText: "1. 첫 상자" })
    .click();
  await page
    .getByLabel("상자 내용", { exact: true })
    .fill("탭을 오가도 남길 정리");
  await page
    .getByRole("spinbutton", { name: "첫 원문 순서", exact: true })
    .fill("7");
  await page.getByRole("button", { name: "연결된 메모", exact: true }).click();
  await expect(
    page.getByText(
      "연결된 메모가 없습니다. 화이트보드에서 메모를 연결해 보세요.",
      { exact: true },
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "생각 묶음", exact: true }).click();
  await expect(page.getByLabel("상자 내용", { exact: true })).toHaveValue(
    "탭을 오가도 남길 정리",
  );
  const serverBoard = fixture.boards.get(WHITEBOARD_ID)!;
  serverBoard.version = 7;
  serverBoard.data.writing!.chapters[0].items = [
    serverBoard.data.writing!.chapters[0].items[1],
  ];
  await page.evaluate(() => (window as any).refreshInventory());
  await page
    .getByRole("button", { name: "내 변경을 최신 보드에 합치기", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "순서를 바꾼 메모가 최신 상자에서 빠졌습니다.",
  );
  await expect(page.getByLabel("상자 내용", { exact: true })).toHaveValue(
    "탭을 오가도 남길 정리",
  );
  await expect(
    page.getByRole("spinbutton", { name: "첫 원문 순서", exact: true }),
  ).toHaveValue("7");
  expect(fixture.commands).toHaveLength(0);
  expect(serverBoard.data.writing!.chapters[0].items).toHaveLength(1);
});
