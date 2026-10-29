import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { randomUUID } from "node:crypto";
import { emptyBoard } from "../src/lib/whiteboard";

let bundle: string;

test.beforeAll(async () => {
  bundle = (
    await build({
      stdin: {
        contents: `import {createRoot} from 'react-dom/client';import {WritingBoardPanel} from './src/components/writing-board/panel';import {AssistLauncher} from './src/components/assist-panel';createRoot(document.getElementById('root')).render(window.fixture.launcherOnly?<AssistLauncher library={window.fixture.library}/>:<WritingBoardPanel ownerId="writing-controls-fixture" library={window.fixture.library} onOpen={()=>{}}/>);`,
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

async function mount(page: Page, launcherOnly = false) {
  const note = {
    id: randomUUID(),
    title: "남겨 둘 원본 메모",
    content: "글감을 삭제해도 이 원본 기록은 남는다.",
    bookId: null,
    kind: "thought",
    page: null,
    tags: [],
    version: 1,
    createdAt: "2026-10-30",
    updatedAt: "2026-10-30",
  };
  const projects = ["첫 글감", "둘째 글감"].map((title) => ({
    id: randomUUID(),
    title,
    question: "보존할 질문",
    kind: "thesis",
    version: 1,
  }));
  const boardData = {
    ...emptyBoard(),
    writing: {
      chapters: [
        {
          id: randomUUID(),
          title: "추천받을 목차",
          text: "기존 정리",
          order: 1,
          x: 24,
          y: 24,
          width: 760,
          height: 320,
          items: [],
        },
      ],
    },
  };
  const boards = new Map(
    projects.map((project, i) => [
      project.id,
      { id: project.id, data: boardData, version: i ? 9 : 5 },
    ]),
  );
  const calls: any[] = [];
  const assistCalls: any[] = [];
  const library = { books: [], notes: [note], cycles: [] };
  const source = {
    notes: [note],
    books: [],
    topics: [],
    memberships: [],
    connections: [],
    topicLinks: [],
    bundles: [],
    bundleLinks: [],
  };
  const summaryGate: { wait?: Promise<void>; release?: () => void } = {};
  await page.route("https://library.test/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/knowledge") {
      if (request.method() === "GET")
        return route.fulfill({
          json: { research: projects, items: [], placements: [] },
        });
      const command = request.postDataJSON();
      calls.push(command);
      if (command.type === "createResearch") {
        const project = {
          ...command.payload,
          id: randomUUID(),
          version: 1,
        };
        projects.push(project);
        return route.fulfill({ json: { id: project.id } });
      }
      if (command.type === "deleteResearch") {
        const index = projects.findIndex((p) => p.id === command.payload.id);
        const board = boards.get(command.payload.id);
        if (
          index < 0 ||
          command.payload.expectedBoardVersion !== (board?.version ?? 0)
        )
          return route.fulfill({
            status: 409,
            json: { error: "다른 기기에서 바뀐 글감입니다." },
          });
        projects.splice(index, 1);
        boards.delete(command.payload.id);
        return route.fulfill({
          json: { id: command.payload.id, deleted: true },
        });
      }
      return route.fulfill({ json: {} });
    }
    if (url.pathname === "/api/whiteboard") {
      const id = url.searchParams.get("boardId")!;
      const board = boards.get(id as ReturnType<typeof randomUUID>);
      if (url.searchParams.get("view") === "summary") {
        await summaryGate.wait;
        return route.fulfill({ json: { id, version: board?.version ?? 0 } });
      }
      return route.fulfill({ json: { ...source, board: board ?? null } });
    }
    if (url.pathname === "/api/assist") {
      assistCalls.push({ method: request.method() });
      return route.fulfill({
        json: { requests: [], policy: {}, usage: [], workers: [] },
      });
    }
    return route.fulfill({ json: {} });
  });
  await page.route("https://library.test/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>',
    }),
  );
  async function render() {
    await page.goto("https://library.test/");
    await page.evaluate(
      (fixture) => {
        (window as any).fixture = fixture;
      },
      { library, launcherOnly },
    );
    await page.addStyleTag({ path: "src/app/globals.css" });
    await page.addScriptTag({ content: bundle, type: "module" });
  }
  await render();
  return { projects, boards, calls, assistCalls, summaryGate, note, render };
}

for (const width of [390, 1280]) {
  test(`project creation stays below the board and above compact selectable titles at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mount(page);
    const canvas = page.locator(".wb-canvas-shell");
    await expect(canvas).toBeVisible();
    const form = page.locator(".writing-project-create");
    const rows = page.locator(".writing-project-row");
    const first = page.getByRole("button", { name: "첫 글감", exact: true });
    const second = page.getByRole("button", { name: "둘째 글감", exact: true });
    const canvasBox = (await canvas.boundingBox())!;
    const formBox = (await form.boundingBox())!;
    const rowBox = (await rows.first().boundingBox())!;
    expect(formBox.y).toBeGreaterThan(canvasBox.y + canvasBox.height);
    expect(rowBox.y).toBeGreaterThanOrEqual(formBox.y + formBox.height);
    await expect(page.getByRole("heading", { name: "글감 목록" })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole("searchbox", { name: "글감 검색" }),
    ).toHaveCount(0);
    expect(rowBox.width).toBeLessThan(330);

    await second.click();
    await expect(second).toHaveAttribute("aria-pressed", "true");
    await fixture.render();
    await expect(second).toHaveAttribute("aria-pressed", "true");
    await first.click();
    await expect(first).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("textbox", { name: "새 글감 제목" }).fill("새 정리");
    await page
      .getByRole("button", { name: "글감 만들기", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "새 정리", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByRole("textbox", { name: "새 글감 제목" }),
    ).toHaveValue("");
    expect(fixture.projects).toHaveLength(3);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`writing-projects-${width}.png`),
      fullPage: true,
    });
  });
}

test("project deletion waits for the board version, preserves notes, and remembers the next selection", async ({
  page,
}) => {
  const fixture = await mount(page);
  const second = fixture.projects[1];
  await page.getByRole("button", { name: second.title, exact: true }).click();
  fixture.summaryGate.wait = new Promise<void>((resolve) => {
    fixture.summaryGate.release = resolve;
  });
  await page
    .getByRole("button", { name: `${second.title} 삭제`, exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "글감 삭제", exact: true });
  const remove = dialog.getByRole("button", { name: "삭제", exact: true });
  await expect(remove).toBeDisabled();
  await expect(dialog).toContainText("원래 메모와 연결 관계는 유지됩니다.");
  fixture.summaryGate.release!();
  await expect(remove).toBeEnabled();
  await remove.click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: second.title, exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "첫 글감", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  const deletion = fixture.calls.find((call) => call.type === "deleteResearch");
  expect(deletion.payload).toEqual({
    id: second.id,
    expectedTitle: "둘째 글감",
    expectedQuestion: "보존할 질문",
    expectedBoardVersion: 9,
  });
  await fixture.render();
  await expect(
    page.getByRole("button", { name: "첫 글감", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.locator(`[data-note-id="${fixture.note.id}"]`).first(),
  ).toBeVisible();
});

test("writing direction and target appear only inside the expanded AI help", async ({
  page,
}) => {
  const fixture = await mount(page);
  await expect(page.locator(".wb-canvas-shell")).toBeVisible();
  const direction = page.getByRole("combobox", {
    name: "AI 도움 방향",
    exact: true,
  });
  const target = page.getByRole("combobox", { name: "대상 목차", exact: true });
  await expect(direction).toBeHidden();
  await expect(target).toBeHidden();
  expect(fixture.assistCalls).toHaveLength(0);
  const launcher = page.locator(".assist-launcher");
  await expect(launcher).toHaveCount(1);
  await launcher.locator(":scope > summary").click();
  await expect(direction).toBeVisible();
  await expect(target).toBeVisible();
  await expect(
    launcher.getByRole("combobox", { name: "AI 도움 방향", exact: true }),
  ).toBeVisible();
  await direction.selectOption("materials");
  await expect(
    launcher.getByText("메모를 추천받을 목차를 선택해 주세요.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    launcher.getByRole("button", { name: "분석할 기록 확인", exact: true }),
  ).toHaveCount(0);
  await target.selectOption({ label: "1. 추천받을 목차" });
  await expect(
    launcher.getByRole("button", { name: "분석할 기록 확인", exact: true }),
  ).toBeVisible();
  await launcher.locator(":scope > summary").click();
  await expect(direction).toBeHidden();
  await expect(target).toBeHidden();
  expect(fixture.assistCalls.every((call) => call.method === "GET")).toBe(true);
});

test("the shared AI launcher still opens its regular assistant without writing controls", async ({
  page,
}) => {
  const fixture = await mount(page, true);
  const launcher = page.locator(".assist-launcher");
  await expect(
    page.getByRole("button", { name: "분석할 기록 확인", exact: true }),
  ).toBeHidden();
  expect(fixture.assistCalls).toHaveLength(0);
  await launcher.locator(":scope > summary").click();
  await expect(
    page.getByRole("combobox", { name: "도움 방향", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "분석할 기록 확인", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".assist-launcher")).toHaveCount(1);
});
