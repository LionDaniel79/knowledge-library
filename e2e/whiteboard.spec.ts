import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { randomUUID } from "node:crypto";
let bundle: string;
test.beforeAll(async () => {
  bundle = (
    await build({
      stdin: {
        contents:
          "import {createRoot} from 'react-dom/client';import {WhiteboardPanel} from './src/components/whiteboard/panel';const root=createRoot(document.getElementById('root'));window.fixtureMount=0;window.refreshBoard=()=>root.render(<WhiteboardPanel key={window.fixtureMount} library={{...window.fixture,notes:[...window.fixture.notes]}} ownerId='whiteboard-fixture' onOpen={(k,id)=>window.opened=id}/>);window.refreshBoard();",
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
async function mount(page: Page, configure?: (state: any) => void) {
  const ids = Array.from({ length: 9 }, () => randomUUID()),
    topics = [
      { id: ids[5], name: "정서", version: 1 },
      { id: ids[6], name: "신학", version: 1 },
    ],
    books = [
      {
        id: ids[7],
        title: "상담 도서",
        author: "상담 저자",
        publisher: "",
        category: "100",
        isbn: "",
        formats: ["paper"],
        tags: [],
        shelf: "",
        totalPages: null,
        version: 1,
        createdAt: "2026-01-01",
      },
      {
        id: ids[8],
        title: "신학 도서",
        author: "신학 저자",
        publisher: "",
        category: "200",
        isbn: "",
        formats: ["paper"],
        tags: [],
        shelf: "",
        totalPages: null,
        version: 1,
        createdAt: "2026-01-01",
      },
    ];
  const notes = ids.slice(0, 5).map((id, i) => ({
    id,
    bookId: i < 3 ? books[0].id : i === 3 ? books[1].id : null,
    title: ["첫 생각", "둘째 생각", "셋째 생각", "신학 기록", ""][i],
    content: [
      "본문에만 나오는 수용의 의미",
      "두 번째 내 생각",
      "세 번째 생각",
      "믿음에 관한 생각",
      "제목 없이 작성한 메모",
    ][i],
    tags: i === 0 ? ["상담"] : i === 1 ? ["철학"] : [],
    kind: "note",
    page: null,
    version: 1,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  }));
  const state: any = {
    board: null,
    notes,
    books,
    topics,
    memberships: [
      {
        topicId: topics[0].id,
        sourceKind: "book",
        sourceId: books[0].id,
        status: "accepted",
      },
      {
        topicId: topics[1].id,
        sourceKind: "book",
        sourceId: books[1].id,
        status: "accepted",
      },
    ],
    connections: [],
  };
  configure?.(state);
  const calls: any[] = [];
  let failSave = false;
  let failLink = false;
  let saveGate: Promise<void> | null = null;
  let releaseSave = () => {};
  await page.route("**/*", async (r) => {
    const u = new URL(r.request().url());
    if (u.hostname !== "library.test") return r.abort();
    if (u.pathname === "/api/whiteboard") return r.fulfill({ json: state });
    if (u.pathname === "/api/knowledge" && r.request().method() === "POST") {
      const c = r.request().postDataJSON();
      calls.push(c);
      if (c.type === "saveWhiteboard") {
        if (failSave)
          return r.fulfill({
            status: 503,
            json: { error: "검수용 저장 실패" },
          });
        if (c.payload.expectedVersion !== (state.board?.version ?? 0))
          return r.fulfill({
            status: 409,
            json: { error: "다른 곳에서 변경" },
          });
        state.board = {
          id: "00000000-0000-4000-8000-000000000001",
          data: c.payload.data,
          version: (state.board?.version ?? 0) + 1,
        };
        if (saveGate) await saveGate;
        return r.fulfill({
          json: { id: state.board.id, version: state.board.version },
        });
      }
      if (c.type === "connectWhiteboardNotes") {
        const old = state.connections.find(
          (x: any) =>
            [x.source_id, x.target_id].includes(c.payload.sourceId) &&
            [x.source_id, x.target_id].includes(c.payload.targetId),
        );
        if (old) return r.fulfill({ json: old });
        const link = {
          id: randomUUID(),
          source_kind: "note",
          source_id: c.payload.sourceId,
          target_kind: "note",
          target_id: c.payload.targetId,
          status: "accepted",
          relation: "related",
          reason: "화이트보드에서 직접 연결",
          version: 1,
        };
        state.connections.push(link);
        return r.fulfill({ json: link });
      }
      if (c.type === "editConnection") {
        if (failLink)
          return r.fulfill({
            status: 503,
            json: { error: "검수용 관계 저장 실패" },
          });
        const link = state.connections.find((x: any) => x.id === c.payload.id);
        if (link.version !== c.payload.expectedVersion)
          return r.fulfill({
            status: 409,
            json: { error: "관계가 변경되었습니다." },
          });
        Object.assign(link, c.payload, { version: link.version + 1 });
        return r.fulfill({ json: link });
      }
      return r.fulfill({ status: 400, json: { error: "Unknown command" } });
    }
    if (u.pathname === "/")
      return r.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html lang="ko"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;padding:16px"><div id="root"></div><script>window.fixture=${JSON.stringify({ books, notes, cycles: [] })}</script></body></html>`,
      });
    return r.abort();
  });
  await page.goto("https://library.test/");
  await page.addStyleTag({ path: "src/app/globals.css" });
  await page.addScriptTag({ content: bundle });
  await expect(page.getByText("5개 메모", { exact: true })).toBeVisible();
  return {
    state,
    calls,
    fail: () => {
      failSave = true;
    },
    failConnection: () => {
      failLink = true;
    },
    allowConnection: () => {
      failLink = false;
    },
    holdSave: () => {
      saveGate = new Promise<void>((resolve) => {
        releaseSave = resolve;
      });
      return () => {
        saveGate = null;
        releaseSave();
      };
    },
  };
}
async function choose(page: Page, label: string, text: string) {
  if (
    !(await page
      .getByRole("textbox", { name: `${label} 검색`, exact: true })
      .isVisible())
  )
    await page
      .getByRole("button", { name: `${label} 선택`, exact: true })
      .click();
  await page
    .getByRole("textbox", { name: `${label} 검색`, exact: true })
    .fill(text);
  await page.getByRole("option", { name: text, exact: true }).click();
}
async function overlap(page: Page, a: string, b: string) {
  const x = await page.locator(`[data-note-id="${a}"]`).boundingBox(),
    y = await page.locator(`[data-note-id="${b}"]`).boundingBox();
  if (!x || !y) throw Error("Missing note");
  await page.mouse.move(x.x + 30, x.y + 20);
  await page.mouse.down();
  await page.mouse.move(y.x + 30, y.y + 20, { steps: 12 });
  await page.mouse.up();
}

function connectedFixture(state: any) {
  state.connections = [
    {
      id: randomUUID(),
      source_kind: "note",
      target_kind: "note",
      source_id: state.notes[0].id,
      target_id: state.notes[1].id,
      status: "accepted",
      relation: "related",
      reason: "검수용 관계",
      version: 1,
    },
  ];
  const key = (i: number) =>
    `topic:${state.topics[0].id}::${state.notes[i].id}`;
  state.board = {
    id: "00000000-0000-4000-8000-000000000001",
    version: 1,
    data: {
      schema: 1,
      filter: { topics: [], tags: [], categories: [], books: [], q: "" },
      positions: { [key(0)]: { x: 50, y: 100 }, [key(1)]: { x: 430, y: 100 } },
      groupPositions: {},
      groups: [],
      collapsed: [],
      links: [],
    },
  };
}

test("line action disconnects the actual note relationship and undo restores it", async ({
  page,
}) => {
  const f = await mount(page, connectedFixture);
  const line = page.getByRole("button", { name: "메모 연결선", exact: true });
  await expect(line).toBeVisible();
  await line.click();
  const actions = page.getByRole("group", { name: "선택한 연결", exact: true });
  await actions.getByRole("button", { name: /끊기/ }).click();
  await expect(line).toHaveCount(0);
  expect(f.state.connections[0].status).toBe("rejected");
  expect(f.state.notes).toHaveLength(5);
  expect(
    f.calls.find((c) => c.type === "editConnection").payload.expectedVersion,
  ).toBe(1);
  await page.getByRole("button", { name: "되돌리기", exact: true }).click();
  await expect(line).toBeVisible();
  expect(f.state.connections[0].status).toBe("accepted");
  expect(
    f.calls.filter((c) => c.type === "editConnection")[1].payload
      .expectedVersion,
  ).toBe(2);
});

test("failed unlink retains the line and selection for retry", async ({
  page,
}) => {
  const f = await mount(page, connectedFixture);
  f.failConnection();
  const line = page.getByRole("button", { name: "메모 연결선", exact: true });
  await line.click();
  const actions = page.getByRole("group", { name: "선택한 연결", exact: true });
  await actions.getByRole("button", { name: /끊기/ }).click();
  await expect(page.getByRole("alert")).toContainText("검수용 관계 저장 실패");
  await expect(line).toBeVisible();
  await expect(actions).toBeVisible();
  expect(f.state.connections[0].status).toBe("accepted");
  f.allowConnection();
  await actions.getByRole("button", { name: /끊기/ }).click();
  await expect(line).toHaveCount(0);
  expect(f.state.connections[0].status).toBe("rejected");
});

test("line selection supports keyboard cancellation and dragging a line only pans", async ({
  page,
}) => {
  const f = await mount(page, connectedFixture);
  const line = page.getByRole("button", { name: "메모 연결선", exact: true });
  await line.focus();
  await line.press("Enter");
  await expect(
    page.getByRole("group", { name: "선택한 연결", exact: true }),
  ).toBeVisible();
  await line.press("Escape");
  await expect(
    page.getByRole("group", { name: "선택한 연결", exact: true }),
  ).toHaveCount(0);
  const rect = await line.boundingBox();
  await page.mouse.move(rect!.x + rect!.width / 2, rect!.y + rect!.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    rect!.x + rect!.width / 2 + 70,
    rect!.y + rect!.height / 2 + 40,
    { steps: 8 },
  );
  await page.mouse.up();
  await expect(
    page.getByRole("group", { name: "선택한 연결", exact: true }),
  ).toHaveCount(0);
  expect(f.calls.filter((c) => c.type === "editConnection")).toHaveLength(0);
  expect(f.state.connections[0].status).toBe("accepted");
});

function collapsedConnections(state: any) {
  connectedFixture(state);
  const [g1, g2] = state.topics.map((t: any) => `topic:${t.id}`);
  state.board.data.positions = {};
  state.board.data.groupPositions = {
    [g1]: { x: 30, y: 30 },
    [g2]: { x: 510, y: 30 },
    unclassified: { x: 30, y: 230 },
  };
  state.board.data.collapsed = [g1, g2];
  state.connections[0].target_id = state.notes[3].id;
  state.connections.push({
    ...state.connections[0],
    id: randomUUID(),
    source_id: state.notes[1].id,
  });
}

test("overlapping grouped relationships can be disconnected one at a time", async ({
  page,
}) => {
  const f = await mount(page, collapsedConnections);
  const line = page.getByRole("button", { name: "메모 연결선", exact: true });
  await line.click();
  const actions = page.getByRole("group", { name: "선택한 연결", exact: true });
  await expect(actions.getByRole("button", { name: /끊기/ })).toHaveCount(2);
  await actions
    .getByRole("button", { name: "첫 생각 ↔ 신학 기록 연결 끊기", exact: true })
    .click();
  await expect(actions.getByRole("button", { name: /끊기/ })).toHaveCount(1);
  await expect(line).toBeVisible();
  expect(f.state.connections.map((c: any) => c.status)).toEqual([
    "rejected",
    "accepted",
  ]);
  expect(f.state.board.data.collapsed).toHaveLength(2);
});

test("group line unlink and undo preserve its notes and their real relationships", async ({
  page,
}) => {
  const f = await mount(page, (state) => {
    collapsedConnections(state);
    state.board.data.links = [
      {
        source: `topic:${state.topics[0].id}`,
        target: `topic:${state.topics[1].id}`,
      },
    ];
  });
  const groupLine = page.getByRole("button", {
    name: "묶음 연결선",
    exact: true,
  });
  await groupLine.click();
  await page
    .getByRole("group", { name: "선택한 연결", exact: true })
    .getByRole("button", { name: "끊기", exact: true })
    .click();
  await expect(groupLine).toHaveCount(0);
  await expect.poll(() => f.state.board.data.links.length).toBe(0);
  expect(f.state.connections.every((c: any) => c.status === "accepted")).toBe(
    true,
  );
  expect(f.state.notes).toHaveLength(5);
  expect(f.state.board.data.collapsed).toHaveLength(2);
  await page.getByRole("button", { name: "되돌리기", exact: true }).click();
  await expect(groupLine).toBeVisible();
});

test("touch line target and unlink controls keep a usable size when zoomed out", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  try {
    const f = await mount(page, connectedFixture);
    await page.getByRole("button", { name: "전체 보기", exact: true }).tap();
    const line = page.getByRole("button", { name: "메모 연결선", exact: true });
    const target = await line.boundingBox();
    expect(target!.height).toBeGreaterThanOrEqual(43.5);
    await line.tap();
    const actions = page.getByRole("group", {
      name: "선택한 연결",
      exact: true,
    });
    const button = actions.getByRole("button", { name: /끊기/ });
    const rect = await button.boundingBox();
    expect(rect!.width).toBeGreaterThanOrEqual(44);
    expect(rect!.height).toBeGreaterThanOrEqual(44);
    expect(
      await page.evaluate(() => document.activeElement?.tagName.toLowerCase()),
    ).not.toBe("input");
    await page.screenshot({
      path: "test-results/whiteboard/mobile-unlink.png",
    });
    await button.tap();
    await expect(line).toHaveCount(0);
    expect(f.state.connections[0].status).toBe("rejected");
  } finally {
    await context.close();
  }
});
test("searchable multi-facets apply only on search and search the complete note body", async ({
  page,
}) => {
  const f = await mount(page);
  await choose(page, "태그", "상담");
  await choose(page, "태그", "철학");
  await page.getByRole("textbox", { name: "메모 제목·내용 검색" }).fill("수용");
  await expect(page.getByText("5개 메모", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect(page.getByText("1개 메모", { exact: true })).toBeVisible();
  await expect(
    page.getByText("본문에만 나오는 수용의 의미", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => f.calls.filter((c) => c.type === "saveWhiteboard").length)
    .toBeGreaterThan(0);
});
test("pending facet choices survive a background board refresh until explicit search", async ({
  page,
}) => {
  const f = await mount(page);
  await choose(page, "주제", "정서");
  await choose(page, "태그", "상담");
  await choose(page, "태그", "철학");
  await choose(page, "분야", "철학·심리학");
  await choose(page, "도서", "상담 도서 · 상담 저자");
  await page
    .getByRole("textbox", { name: "메모 제목·내용 검색", exact: true })
    .fill("수용");
  f.state.board = {
    id: "00000000-0000-4000-8000-000000000001",
    version: 1,
    data: {
      schema: 1,
      filter: { topics: [], tags: [], categories: [], books: [], q: "" },
      positions: {},
      groupPositions: {},
      groups: [],
      collapsed: [],
      links: [],
    },
  };
  await Promise.all([
    page.waitForResponse(
      (r) => new URL(r.url()).pathname === "/api/whiteboard",
    ),
    page.evaluate(() => (window as any).refreshBoard()),
  ]);
  await page.waitForTimeout(100);
  await expect(
    page.getByRole("button", { name: "주제 선택", exact: true }),
  ).toContainText("정서");
  await expect(
    page.getByRole("button", { name: "태그 선택", exact: true }),
  ).toContainText("2개 선택");
  await expect(
    page.getByRole("button", { name: "분야 선택", exact: true }),
  ).toContainText("철학·심리학");
  await expect(
    page.getByRole("button", { name: "도서 선택", exact: true }),
  ).toContainText("상담 도서");
  await expect(
    page.getByRole("textbox", { name: "메모 제목·내용 검색", exact: true }),
  ).toHaveValue("수용");
  await page.getByRole("button", { name: "태그 선택", exact: true }).click();
  await page.getByRole("textbox", { name: "태그 검색", exact: true }).fill("");
  await expect(
    page.getByRole("option", { name: "상담", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("option", { name: "철학", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("5개 메모", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect(page.getByText("1개 메모", { exact: true })).toBeVisible();
});
test("mobile picker opens as a stable list and focuses search only on a direct tap", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  try {
    await mount(page);
    await page.evaluate(() => {
      document.body.style.minHeight = "1600px";
    });
    await page.getByRole("button", { name: "주제 선택", exact: true }).tap();
    const input = page.getByRole("textbox", { name: "주제 검색", exact: true }),
      popup = page.locator(".wb-facet-popup");
    await expect(input).not.toBeFocused();
    const original = await popup.evaluate((e) => ({
      top: parseFloat((e as HTMLElement).style.top),
      left: parseFloat((e as HTMLElement).style.left),
    }));
    await page.screenshot({
      path: "E:/지식서재 작업/private-data/runtime/whiteboard-dropdown-20261024.png",
      fullPage: false,
    });
    await page.evaluate(() => window.scrollTo(0, 24));
    const gap = await page.evaluate(
      () =>
        document.querySelector(".wb-facet-popup")!.getBoundingClientRect().top -
        document
          .querySelector('[aria-label="주제 선택"]')!
          .getBoundingClientRect().bottom,
    );
    expect(gap).toBeCloseTo(6, 0);
    await input.tap();
    await expect(input).toBeFocused();
    await page.setViewportSize({ width: 390, height: 420 });
    expect(
      await popup.evaluate((e) => parseFloat((e as HTMLElement).style.top)),
    ).toBe(original.top);
    expect(
      await popup.evaluate((e) => parseFloat((e as HTMLElement).style.left)),
    ).toBe(original.left);
    expect(
      await input.evaluate((e) => parseFloat(getComputedStyle(e).fontSize)),
    ).toBeGreaterThanOrEqual(16);
    await input.fill("정서");
    await page.getByRole("option", { name: "정서", exact: true }).tap();
    await expect(
      page.getByRole("button", { name: "주제 선택", exact: true }),
    ).toContainText("정서");
  } finally {
    await context.close();
  }
});
test("search brings two distant book memos together at a readable size without connecting them", async ({
  page,
}) => {
  const f = await mount(page);
  f.state.notes[2].bookId = f.state.books[1].id;
  const key = (i: number) =>
    `topic:${f.state.topics[0].id}::${f.state.notes[i].id}`;
  f.state.board = {
    id: "00000000-0000-4000-8000-000000000001",
    version: 1,
    data: {
      schema: 1,
      filter: { topics: [], tags: [], categories: [], books: [], q: "" },
      positions: { [key(0)]: { x: 46, y: 84 }, [key(1)]: { x: 46, y: 8000 } },
      groupPositions: {},
      groups: [],
      collapsed: [],
      links: [],
    },
  };
  await Promise.all([
    page.waitForResponse(
      (r) => new URL(r.url()).pathname === "/api/whiteboard",
    ),
    page.evaluate(() => (window as any).refreshBoard()),
  ]);
  await page.waitForTimeout(100);
  await choose(page, "도서", "상담 도서 · 상담 저자");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect(page.getByText("2개 메모", { exact: true })).toBeVisible();
  const a = await page
      .locator(`[data-note-id="${f.state.notes[0].id}"]`)
      .boundingBox(),
    b = await page
      .locator(`[data-note-id="${f.state.notes[1].id}"]`)
      .boundingBox();
  expect(a!.width).toBeGreaterThanOrEqual(180);
  expect(Math.abs(a!.y - b!.y)).toBeLessThan(10);
  expect(Math.abs(a!.x - b!.x)).toBeLessThan(300);
  expect(f.state.connections).toHaveLength(0);
  const viewport = await page.locator(".wb-viewport").boundingBox();
  await page.mouse.move(
    viewport!.x + viewport!.width - 30,
    viewport!.y + viewport!.height - 40,
  );
  await page.mouse.down();
  await page.mouse.move(viewport!.x + 30, viewport!.y + viewport!.height - 40, {
    steps: 12,
  });
  await page.mouse.up();
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect
    .poll(async () => {
      const note = await page
        .locator(`[data-note-id="${f.state.notes[0].id}"]`)
        .boundingBox();
      return (
        !!note &&
        note.x >= viewport!.x &&
        note.x + note.width <= viewport!.x + viewport!.width
      );
    })
    .toBe(true);
  await page.screenshot({
    path: "E:/지식서재 작업/private-data/runtime/whiteboard-compact-20261024.png",
    fullPage: false,
  });
});
test("opening an old automatically spaced filtered board compacts its matching memos", async ({
  page,
}) => {
  const f = await mount(page),
    topic = f.state.topics[0].id;
  f.state.notes = Array.from({ length: 150 }, (_, i) => ({
    ...f.state.notes[0],
    id: randomUUID(),
    title: `메모 ${i}`,
    tags: i === 0 || i === 149 ? ["찾기"] : [],
  }));
  f.state.board = {
    id: "00000000-0000-4000-8000-000000000001",
    version: 1,
    data: {
      schema: 1,
      filter: { topics: [], tags: ["찾기"], categories: [], books: [], q: "" },
      positions: Object.fromEntries(
        f.state.notes.map((n: any, i: number) => [
          `topic:${topic}::${n.id}`,
          { x: 46 + (i % 3) * 236, y: 84 + Math.floor(i / 3) * 182 },
        ]),
      ),
      groupPositions: { [`topic:${topic}`]: { x: 30, y: 30 } },
      groups: [],
      collapsed: [],
      links: [],
    },
  };
  await page.evaluate(() => {
    (window as any).fixtureMount++;
    (window as any).refreshBoard();
  });
  await expect(page.getByText("2개 메모", { exact: true })).toBeVisible();
  const a = await page
      .locator(`[data-note-id="${f.state.notes[0].id}"]`)
      .boundingBox(),
    b = await page
      .locator(`[data-note-id="${f.state.notes[149].id}"]`)
      .boundingBox();
  expect(Math.abs(a!.y - b!.y)).toBeLessThan(10);
  expect(Math.abs(a!.x - b!.x)).toBeLessThan(300);
});
test("touch facet selections stay checked after reopening and apply together on search", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  try {
    await mount(page);
    await page.getByRole("button", { name: "주제 선택", exact: true }).tap();
    await page.getByRole("option", { name: "정서", exact: true }).tap();
    await page.getByRole("button", { name: "태그 선택", exact: true }).tap();
    await page.getByRole("option", { name: "상담", exact: true }).tap();
    await page.getByRole("option", { name: "철학", exact: true }).tap();
    await page.getByRole("button", { name: "태그 선택", exact: true }).tap();
    await page.getByRole("button", { name: "태그 선택", exact: true }).tap();
    await expect(
      page.getByRole("option", { name: "상담", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(
      page.getByRole("option", { name: "철학", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText("5개 메모", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "검색", exact: true }).tap();
    await expect(page.getByText("2개 메모", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "주제 선택", exact: true }),
    ).toContainText("정서");
  } finally {
    await context.close();
  }
});
test("drag overlap links real note IDs and supports folding, group links, open and undo", async ({
  page,
}) => {
  const f = await mount(page);
  await choose(page, "주제", "정서");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect(page.getByText("3개 메모", { exact: true })).toBeVisible();
  await overlap(page, f.state.notes[0].id, f.state.notes[1].id);
  await expect.poll(() => f.state.connections.length).toBe(1);
  expect(
    new Set([
      f.state.connections[0].source_id,
      f.state.connections[0].target_id,
    ]),
  ).toEqual(new Set(f.state.notes.slice(0, 2).map((n: any) => n.id)));
  await page
    .getByRole("button", { name: "메모 묶음 펼치기", exact: true })
    .click();
  await expect(
    page.locator(`[data-note-id="${f.state.notes[0].id}"]`),
  ).toBeVisible();
  await page.getByRole("button", { name: "첫 생각 열기", exact: true }).click();
  expect(await page.evaluate(() => (window as any).opened)).toBe(
    f.state.notes[0].id,
  );
  await page
    .getByRole("button", { name: "메모 묶음 접기", exact: true })
    .click();
  await page.getByRole("button", { name: "주제 선택", exact: true }).click();
  await page.getByRole("option", { name: /전체/ }).click();
  await page.getByRole("button", { name: "검색", exact: true }).click();
  const manual = page
    .locator(".wb-group")
    .filter({ has: page.locator("strong", { hasText: "메모 묶음" }) });
  await manual.getByRole("button", { name: "메모 묶음 묶음 선택" }).click();
  await page
    .getByRole("button", { name: "선택한 묶음 연결", exact: true })
    .click();
  await page
    .getByRole("button", { name: "신학 묶음 선택", exact: true })
    .click();
  await expect.poll(() => f.state.board?.data.links.length).toBe(1);
  await page.getByRole("button", { name: "되돌리기", exact: true }).click();
  await expect.poll(() => f.state.board?.data.links.length).toBe(0);
});
test("a click does not link and failed saves preserve an account-scoped board draft", async ({
  page,
}) => {
  const f = await mount(page);
  f.fail();
  await page.getByRole("button", { name: "신학 접기", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("검수용 저장 실패");
  expect(
    await page.evaluate(
      () =>
        JSON.parse(
          localStorage.getItem("library:whiteboard-draft:whiteboard-fixture")!,
        ).dirty,
    ),
  ).toBe(true);
  expect(f.state.connections).toHaveLength(0);
  await page.locator(`[data-note-id="${f.state.notes[0].id}"]`).click();
  expect(f.state.connections).toHaveLength(0);
});
test("mobile controls stay inside the screen while the toolbar scrolls independently", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mount(page);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "태그 선택", exact: true }).click();
  const pop = await page.locator(".wb-facet-popup").boundingBox();
  expect(pop!.x).toBeGreaterThanOrEqual(0);
  expect(pop!.x + pop!.width).toBeLessThanOrEqual(391);
  await page.keyboard.press("Escape");
  await page.screenshot({
    path: "E:/지식서재 작업/private-data/runtime/whiteboard-mobile-20261023.png",
    fullPage: true,
  });
});
test("touch drag cancellation does not connect; releasing the touch connects the two real notes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const f = await mount(page);
  await choose(page, "주제", "정서");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect(page.getByText("3개 메모", { exact: true })).toBeVisible();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", {
    enabled: true,
    maxTouchPoints: 1,
  });
  async function touch(cancel: boolean) {
    const a = await page
        .locator(`[data-note-id="${f.state.notes[0].id}"]`)
        .boundingBox(),
      b = await page
        .locator(`[data-note-id="${f.state.notes[1].id}"]`)
        .boundingBox();
    if (!a || !b) throw Error("No touch targets");
    const start = { x: a.x + 28, y: a.y + 18, id: 0 };
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [start],
    });
    for (let i = 1; i <= 8; i++)
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          {
            x: start.x + ((b.x - a.x) * i) / 8,
            y: start.y + ((b.y - a.y) * i) / 8,
            id: 0,
          },
        ],
      });
    await cdp.send("Input.dispatchTouchEvent", {
      type: cancel ? "touchCancel" : "touchEnd",
      touchPoints: [],
    });
  }
  await touch(true);
  expect(f.state.connections).toHaveLength(0);
  await touch(false);
  await expect.poll(() => f.state.connections.length).toBe(1);
});
test("keyboard note selection offers the same real connection without dragging", async ({
  page,
}) => {
  const f = await mount(page);
  const a = page.locator(`[data-note-id="${f.state.notes[0].id}"]`),
    b = page.locator(`[data-note-id="${f.state.notes[1].id}"]`);
  await a.focus();
  await a.press("Enter");
  await page
    .getByRole("button", { name: "선택한 메모 연결", exact: true })
    .click();
  await b.focus();
  await b.press("Enter");
  await expect.poll(() => f.state.connections.length).toBe(1);
  await page.screenshot({
    path: "E:/지식서재 작업/private-data/runtime/whiteboard-desktop-20261023.png",
    fullPage: true,
  });
});
test("reloaded authoritative board replaces a clean layout at the same or earlier version", async ({
  page,
}) => {
  const f = await mount(page);
  await choose(page, "주제", "정서");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect.poll(() => f.state.board?.version).toBe(1);
  f.state.board.data.filter.topics = [f.state.topics[1].id];
  f.state.resolutionToken = "fixture-resolution-1";
  await page.evaluate(() => (window as any).refreshBoard());
  await expect(page.getByText("1개 메모", { exact: true })).toBeVisible();
  f.state.board = null;
  f.state.resolutionToken = "fixture-resolution-2";
  await page.evaluate(() => (window as any).refreshBoard());
  await expect(page.getByText("5개 메모", { exact: true })).toBeVisible();
});
test("undo never overwrites a subsequently revised relationship judgment", async ({
  page,
}) => {
  const f = await mount(page);
  const a = page.locator(`[data-note-id="${f.state.notes[0].id}"]`),
    b = page.locator(`[data-note-id="${f.state.notes[1].id}"]`);
  await a.focus();
  await a.press("Enter");
  await page
    .getByRole("button", { name: "선택한 메모 연결", exact: true })
    .click();
  await b.focus();
  await b.press("Enter");
  await expect.poll(() => f.state.connections.length).toBe(1);
  Object.assign(f.state.connections[0], {
    version: 2,
    relation: "challenges",
    reason: "나중에 확인한 판단",
  });
  await page.evaluate(() => (window as any).refreshBoard());
  await page.locator(".wb-connection-list summary").click();
  await expect(page.locator(".wb-connection-list small")).toContainText("반론");
  await page.getByRole("button", { name: "되돌리기", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("관계가 변경");
  expect(f.state.connections[0].version).toBe(2);
  expect(f.state.connections[0].reason).toBe("나중에 확인한 판단");
});
test("a delayed own save echo neither conflicts with nor replaces a newer edit", async ({
  page,
}) => {
  const f = await mount(page);
  await choose(page, "주제", "정서");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect.poll(() => f.state.board?.version).toBe(1);
  const earlier = structuredClone(f.state.board);
  await choose(page, "주제", "신학");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await page.evaluate(() => (window as any).refreshBoard());
  await expect.poll(() => f.state.board?.version).toBe(2);
  await expect(page.getByText("4개 메모", { exact: true })).toBeVisible();
  f.state.board = earlier;
  await page.evaluate(() => (window as any).refreshBoard());
  await page.waitForTimeout(250);
  await expect(page.getByText("4개 메모", { exact: true })).toBeVisible();
  await expect(
    page.getByText("다른 곳의 배치와 현재 배치가 다릅니다.", { exact: false }),
  ).toHaveCount(0);
});
test("a draft from before a resolution is preserved for choice rather than automatically saved", async ({
  page,
}) => {
  const f = await mount(page);
  await choose(page, "주제", "정서");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect.poll(() => f.state.board?.version).toBe(1);
  await expect(page.getByRole("status")).toContainText("저장됨");
  const draft = {
    data: structuredClone(f.state.board.data),
    version: 1,
    dirty: true,
    resolutionToken: "older-resolution",
  };
  draft.data.filter.q = "보관할 새 편집";
  f.state.resolutionToken = "newer-resolution";
  await page.evaluate((draft) => {
    localStorage.setItem(
      "library:whiteboard-draft:whiteboard-fixture",
      JSON.stringify(draft),
    );
    (window as any).fixtureMount++;
    (window as any).refreshBoard();
  }, draft);
  await expect(
    page.getByRole("button", { name: "현재 배치로 저장", exact: true }),
  ).toBeVisible();
  await page.waitForTimeout(500);
  expect(f.state.board.version).toBe(1);
  expect(f.state.board.data.filter.q).toBe("");
  await page
    .getByRole("textbox", { name: "메모 제목·내용 검색", exact: true })
    .fill("선택 전 추가 편집");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await page.evaluate(() => {
    (window as any).fixtureMount++;
    (window as any).refreshBoard();
  });
  await expect(
    page.getByRole("button", { name: "현재 배치로 저장", exact: true }),
  ).toBeVisible();
  await page.waitForTimeout(500);
  expect(f.state.board.version).toBe(1);
});
test("a late save from a closed board cannot replace a newer draft awaiting choice", async ({
  page,
}) => {
  const f = await mount(page),
    release = f.holdSave();
  await choose(page, "주제", "정서");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect.poll(() => f.state.board?.version).toBe(1);
  await page.evaluate(() => {
    (window as any).fixtureMount++;
    (window as any).refreshBoard();
  });
  await expect(
    page.getByRole("button", { name: "현재 배치로 저장", exact: true }),
  ).toBeVisible();
  const reply = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/knowledge",
  );
  release();
  await reply;
  await page.waitForTimeout(100);
  await page.evaluate(() => {
    (window as any).fixtureMount++;
    (window as any).refreshBoard();
  });
  await expect(
    page.getByRole("button", { name: "현재 배치로 저장", exact: true }),
  ).toBeVisible();
});
