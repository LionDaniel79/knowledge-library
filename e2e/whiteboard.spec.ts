import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { randomUUID } from "node:crypto";
import { emptyBoard } from "../src/lib/whiteboard";
let bundle: string;

test("ordinary wheel zooms around the cursor without moving notes or scrolling the page", async ({
  page,
  browserName,
}) => {
  await mount(page);
  const viewport = page.locator(".wb-viewport");
  await viewport.scrollIntoViewIfNeeded();
  const box = (await viewport.boundingBox())!;
  const cursor = { x: Math.round(box.x + 180), y: Math.round(box.y + 170) };
  const wheel = async (deltaY: number) => {
    if (browserName === "webkit")
      await viewport.dispatchEvent("wheel", {
        deltaY,
        clientX: cursor.x,
        clientY: cursor.y,
        cancelable: true,
      });
    else await page.mouse.wheel(0, deltaY);
  };
  const camera = () =>
    page.locator(".wb-world").evaluate((el) => {
      const m = new DOMMatrix(getComputedStyle(el).transform);
      return { x: m.e, y: m.f, zoom: m.a, scroll: window.scrollY };
    });
  const before = await camera();
  const positions = await page
    .locator(".wb-note")
    .evaluateAll((els) => els.map((el) => (el as HTMLElement).style.cssText));
  await page.mouse.move(cursor.x, cursor.y);
  await wheel(-100);
  await expect
    .poll(async () => (await camera()).zoom)
    .toBeGreaterThan(before.zoom);
  const after = await camera();
  expect((cursor.x - box.x - after.x) / after.zoom).toBeCloseTo(
    (cursor.x - box.x - before.x) / before.zoom,
    3,
  );
  expect((cursor.y - box.y - after.y) / after.zoom).toBeCloseTo(
    (cursor.y - box.y - before.y) / before.zoom,
    3,
  );
  expect(after.scroll).toBe(before.scroll);
  expect(
    await page
      .locator(".wb-note")
      .evaluateAll((els) => els.map((el) => (el as HTMLElement).style.cssText)),
  ).toEqual(positions);
  await wheel(100);
  await expect
    .poll(async () => (await camera()).zoom)
    .toBeCloseTo(before.zoom, 3);
  await viewport.dispatchEvent("wheel", {
    deltaY: -100000,
    clientX: cursor.x,
    clientY: cursor.y,
    cancelable: true,
  });
  await expect.poll(async () => (await camera()).zoom).toBe(1.8);
  await viewport.dispatchEvent("wheel", {
    deltaY: 100000,
    clientX: cursor.x,
    clientY: cursor.y,
    cancelable: true,
  });
  await expect.poll(async () => (await camera()).zoom).toBe(0.1);
});

test("fullscreen fills the display and returns without resetting camera or page scroll", async ({
  page,
}, testInfo) => {
  await mount(page);
  const shell = page.locator(".wb-canvas-shell");
  await shell.scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "축소", exact: true }).click();
  const before = await shell.boundingBox();
  const camera = await page.locator(".wb-world").getAttribute("style");
  const scroll = await page.evaluate(() => window.scrollY);
  const enter = page.getByRole("button", { name: "전체화면", exact: true });
  await expect(page.locator(".wb-zoom button").last()).toHaveText("전체화면");
  await enter.click();
  await expect(
    page.getByRole("button", { name: "이전화면", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      shell.evaluate((el) => {
        const b = el.getBoundingClientRect();
        return (
          Math.abs(b.x) +
          Math.abs(b.y) +
          Math.abs(b.width - innerWidth) +
          Math.abs(b.height - innerHeight)
        );
      }),
    )
    .toBeLessThan(3);
  const supportsNative = await page.evaluate(() => document.fullscreenEnabled);
  if (supportsNative)
    await expect
      .poll(() => shell.evaluate((el) => document.fullscreenElement === el))
      .toBe(true);
  await page.screenshot({ path: testInfo.outputPath("fullscreen.png") });
  expect(await page.locator(".wb-world").getAttribute("style")).toBe(camera);
  await page.getByRole("button", { name: "이전화면", exact: true }).click();
  await expect(enter).toBeVisible();
  await expect
    .poll(async () => (await shell.boundingBox())!.height)
    .toBeCloseTo(before!.height, 0);
  await expect
    .poll(() => page.evaluate(() => window.scrollY))
    .toBeCloseTo(scroll, 0);
  expect(await page.locator(".wb-world").getAttribute("style")).toBe(camera);
  await enter.click();
  await page.keyboard.press("Escape");
  await expect(enter).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement === null))
    .toBe(true);
  await page.evaluate(() => {
    (window as any).fixtureEditor = true;
  });
  await enter.click();
  await page.getByRole("button", { name: "첫 생각 열기", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "기록 수정" })).toBeVisible();
  await expect(shell).toHaveClass(/wb-fullscreen/);
  if (supportsNative)
    expect(
      await shell.evaluate((el) => document.fullscreenElement === el),
    ).toBe(true);
  await page
    .getByRole("dialog", { name: "기록 수정" })
    .getByRole("button", { name: "닫기", exact: true })
    .click();
  await expect(shell).toHaveClass(/wb-fullscreen/);
  expect(await page.locator(".wb-world").getAttribute("style")).toBe(camera);
});

for (const failure of ["unsupported", "rejected"] as const) {
  test(`fullscreen ${failure} uses a reversible viewport fallback and details remain accessible`, async ({
    page,
  }) => {
    await mount(page);
    await page.evaluate((failure) => {
      (window as any).fixtureEditor = true;
      Object.defineProperty(Element.prototype, "requestFullscreen", {
        configurable: true,
        value:
          failure === "unsupported"
            ? undefined
            : () => Promise.reject(new Error("denied")),
      });
    }, failure);
    const enter = page.getByRole("button", { name: "전체화면", exact: true });
    const oldOverflow = await page.evaluate(() => document.body.style.overflow);
    await enter.click();
    await expect(
      page.getByRole("button", { name: "이전화면", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".wb-canvas-shell")).toHaveClass(/wb-fullscreen/);
    await page.keyboard.press("Escape");
    await expect(enter).toBeVisible();
    expect(await page.evaluate(() => document.body.style.overflow)).toBe(
      oldOverflow,
    );
    await enter.click();
    await page
      .getByRole("button", { name: "첫 생각 열기", exact: true })
      .click();
    await expect(page.getByRole("dialog", { name: "기록 수정" })).toBeVisible();
    await expect(page.locator(".wb-canvas-shell")).toHaveClass(/wb-fullscreen/);
    expect(await page.evaluate(() => document.body.style.overflow)).toBe(
      "hidden",
    );
    await page
      .getByRole("dialog", { name: "기록 수정" })
      .getByRole("button", { name: "닫기", exact: true })
      .click();
    await expect(page.locator(".wb-canvas-shell")).toHaveClass(/wb-fullscreen/);
    await page
      .getByRole("button", { name: "첫 생각 열기", exact: true })
      .click();
    await expect(page.getByRole("dialog", { name: "기록 수정" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "기록 수정" })).toHaveCount(
      0,
    );
    await expect(page.locator(".wb-canvas-shell")).toHaveClass(/wb-fullscreen/);
    await page.evaluate(() => {
      (window as any).fixtureMount++;
      (window as any).flushBoard();
    });
    await expect(enter).toBeVisible();
    expect(await page.evaluate(() => document.body.style.overflow)).toBe(
      oldOverflow,
    );
  });
}

test("fullscreen note editor is half sized, scrolls vertically and retains the field columns", async ({
  page,
}, testInfo) => {
  await mount(page);
  await page.evaluate(() => {
    (window as any).fixtureEditor = true;
  });
  const open = page.getByRole("button", { name: "첫 생각 열기", exact: true }),
    dialog = page.getByRole("dialog", { name: "기록 수정" });
  await open.click();
  const normal = (await dialog.boundingBox())!;
  await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  await page.getByRole("button", { name: "전체화면", exact: true }).click();
  await open.click();
  await expect(dialog).toBeVisible();
  const compact = (await dialog.boundingBox())!;
  expect(compact.width).toBeCloseTo(normal.width, 0);
  expect(compact.height).toBeCloseTo(normal.height, 0);
  expect(compact.width).toBeLessThanOrEqual(306);
  const noteRect = (await page.locator(".wb-note").first().boundingBox())!;
  const screen = page.viewportSize()!;
  expect(compact.x).toBeGreaterThanOrEqual(8);
  expect(compact.x + compact.width).toBeLessThanOrEqual(screen.width - 7);
  if (screen.width >= 900) {
    expect(compact.x).toBeGreaterThanOrEqual(noteRect.x + noteRect.width);
    expect(compact.x - noteRect.x - noteRect.width).toBeLessThanOrEqual(14);
  }
  expect(
    await dialog.evaluate(
      (el) =>
        el.scrollHeight > el.clientHeight &&
        el.scrollWidth <= el.clientWidth + 1,
    ),
  ).toBe(true);
  const columns = await dialog
    .locator(".form-row")
    .first()
    .evaluate((el) => {
      const fields = Array.from(el.children).map((c) =>
        c.getBoundingClientRect(),
      );
      return {
        left: fields[0].x,
        right: fields[1].x,
        overlap: fields[0].right > fields[1].x,
      };
    });
  expect(columns.right).toBeGreaterThan(columns.left);
  expect(columns.overlap).toBe(false);
  await dialog
    .locator('textarea[name="content"]')
    .fill("전체화면에서도 기록을 편집합니다.");
  await dialog.evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect(
    dialog.getByRole("button", { name: "저장하기", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".wb-canvas-shell")).toHaveClass(/wb-fullscreen/);
  await dialog.evaluate((el) => (el.scrollTop = 0));
  await page.screenshot({ path: testInfo.outputPath("compact-note.png") });
  await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "이전화면", exact: true }),
  ).toBeVisible();
});

test("a note can be dragged left and above the world origin without snapping back after save", async ({
  page,
}) => {
  const f = await mount(page),
    viewport = page.locator(".wb-viewport");
  await page.getByRole("button", { name: "전체화면", exact: true }).click();
  await expect(page.locator(".wb-canvas-shell")).toHaveClass(/wb-fullscreen/);
  const vp = (await viewport.boundingBox())!;
  const world = page.locator(".wb-world"),
    before = await world.getAttribute("style");
  await viewport.dispatchEvent("wheel", {
    deltaX: -Math.min(500, vp.width * 0.4),
    deltaY: -220,
    shiftKey: true,
    cancelable: true,
  });
  await expect(world).not.toHaveAttribute("style", before!);
  const note = page.locator(".wb-note").filter({
    has: page.getByRole("button", { name: "첫 생각 열기", exact: true }),
  });
  const box = (await note.boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + 30);
  await page.mouse.down();
  await page.mouse.move(vp.x + 12, vp.y + 18, { steps: 10 });
  await page.mouse.up();
  await expect
    .poll(() => f.calls.filter((c) => c.type === "saveWhiteboard").length)
    .toBeGreaterThan(0);
  const position = await note.evaluate((el) => ({
    x: parseFloat((el as HTMLElement).style.left),
    y: parseFloat((el as HTMLElement).style.top),
  }));
  expect(position.x).toBeLessThan(0);
  expect(position.y).toBeLessThan(0);
  await expect(page.getByText("저장됨", { exact: true })).toBeVisible();
  const saved = f.calls.filter((c) => c.type === "saveWhiteboard").at(-1)
    .payload.data;
  const stored = (
    Object.values(saved.positions) as { x: number; y: number }[]
  ).find((p) => p.x < 0 && p.y < 0)!;
  expect(stored.x).toBeCloseTo(position.x, 3);
  expect(stored.y).toBeCloseTo(position.y, 3);
  await page.evaluate(() => (window as any).flushBoard());
  expect(
    await note.evaluate((el) => ({
      x: parseFloat((el as HTMLElement).style.left),
      y: parseFloat((el as HTMLElement).style.top),
    })),
  ).toEqual(position);
});

test("connections remain visible and selectable on the negative side of the board", async ({
  page,
}) => {
  await mount(page, (state) => {
    connectedFixture(state);
    state.notes = state.notes.slice(0, 2);
    for (const p of Object.values(state.board.data.positions) as any[]) {
      p.x -= 100000;
      p.y -= 100000;
    }
  });
  expect(
    await page
      .locator(".wb-note")
      .first()
      .evaluate((el) => parseFloat((el as HTMLElement).style.left)),
  ).toBeLessThan(0);
  const line = page.getByRole("button", { name: "메모 연결선", exact: true });
  await expect(line).toBeVisible();
  await line.locator(".wb-edge-hit").click();
  await expect(
    page.getByRole("group", { name: "선택한 연결", exact: true }),
  ).toBeVisible();
});

test("unclassified topic selection is searchable and persists through board save", async ({
  page,
}) => {
  const f = await mount(page);
  await choose(page, "주제", "미분류");
  await expect(
    page.getByRole("button", { name: "주제 선택", exact: true }),
  ).toContainText("미분류");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect(page.locator(".wb-note")).toHaveCount(1);
  expect(await page.locator(".wb-note").getAttribute("data-note-id")).toBe(
    f.state.notes[4].id,
  );
  await expect
    .poll(
      () =>
        f.calls.filter((c) => c.type === "saveWhiteboard").at(-1)?.payload.data
          .filter.topics,
    )
    .toEqual(["unclassified"]);
  await choose(page, "주제", "정서");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect(page.locator(".wb-note")).toHaveCount(4);
});

test("bulk folding preserves note positions and connections and can undo without resetting the camera", async ({
  page,
}) => {
  const f = await mount(page, connectedFixture);
  await page.getByRole("button", { name: "전체 보기", exact: true }).click();
  const camera = await page.locator(".wb-world").getAttribute("style");
  const positions = await page
    .locator(".wb-note")
    .evaluateAll((els) => els.map((el) => (el as HTMLElement).style.cssText));
  const ids = await page
    .locator(".wb-group")
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-group-id")));
  await page.getByRole("button", { name: "전체 접음", exact: true }).click();
  await expect(page.locator(".wb-group.collapsed")).toHaveCount(ids.length);
  await expect(page.locator(".wb-note")).toHaveCount(0);
  expect(await page.locator(".wb-world").getAttribute("style")).toBe(camera);
  await expect
    .poll(
      () =>
        f.calls.filter((c) => c.type === "saveWhiteboard").at(-1)?.payload.data
          .collapsed,
    )
    .toEqual(ids);
  await page.getByRole("button", { name: "되돌리기", exact: true }).click();
  await expect(page.locator(".wb-note")).toHaveCount(5);
  await page.getByRole("button", { name: "전체 접음", exact: true }).click();
  await page.getByRole("button", { name: "전체 펼침", exact: true }).click();
  await expect(page.locator(".wb-group.collapsed")).toHaveCount(0);
  expect(
    await page
      .locator(".wb-note")
      .evaluateAll((els) => els.map((el) => (el as HTMLElement).style.cssText)),
  ).toEqual(positions);
  expect(await page.locator(".wb-world").getAttribute("style")).toBe(camera);
  expect(f.state.connections).toHaveLength(1);
});

test.beforeAll(async () => {
  bundle = (
    await build({
      stdin: {
        contents: `import {createRoot} from 'react-dom/client';import{flushSync}from'react-dom';import{useState}from'react';import {WhiteboardPanel} from './src/components/whiteboard/panel';import{LibraryForm}from'./src/components/library-forms';const root=createRoot(document.getElementById('root'));window.fixtureMount=0;function App(){const[editor,setEditor]=useState(null);const library={...window.fixture,notes:[...window.fixture.notes]};return <><WhiteboardPanel library={library} writingTitle={window.fixture.writingTitle} ownerId='whiteboard-fixture' onOpen={(k,id,anchor)=>{window.opened=id;if(window.fixtureEditor)setEditor({kind:'note',note:library.notes.find(n=>n.id===id),anchor});}}/>{editor&&<LibraryForm editor={editor} library={library} today='2026-10-27' preview={false} onClose={()=>setEditor(null)} onSave={async()=>{throw Error('검수 중 메모 본문 변경 금지')}}/>}</>}window.refreshBoard=()=>root.render(<App key={window.fixtureMount}/>);window.flushBoard=()=>flushSync(window.refreshBoard);window.refreshBoard();`,
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
    if (u.pathname === "/api/thought-boxes")
      return r.fulfill({ json: { items: [] } });
    if (u.pathname === "/api/whiteboard")
      return r.fulfill({
        json:
          u.searchParams.get("view") === "visibility"
            ? {
                visible: !(state.board?.data.hiddenNoteIds ?? []).includes(
                  u.searchParams.get("noteId"),
                ),
              }
            : state,
      });
    if (u.pathname === "/api/knowledge" && r.request().method() === "POST") {
      const c = r.request().postDataJSON();
      calls.push(c);
      if (
        c.type === "setWhiteboardNoteVisibility" ||
        c.type === "setWhiteboardNotesVisibility"
      ) {
        const noteIds = c.payload.noteIds ?? [c.payload.noteId];
        const data = state.board?.data ?? emptyBoard();
        state.board = {
          id: "00000000-0000-4000-8000-000000000001",
          version: (state.board?.version ?? 0) + 1,
          data: {
            ...data,
            hiddenNoteIds: c.payload.visible
              ? (data.hiddenNoteIds ?? []).filter(
                  (id: string) => !noteIds.includes(id),
                )
              : [...new Set([...(data.hiddenNoteIds ?? []), ...noteIds])],
          },
        };
        await page.evaluate(() => (window as any).refreshBoard());
        return r.fulfill({
          json: { id: state.board.id, version: state.board.version },
        });
      }
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
        body: `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;padding:16px"><div id="root"></div><script>window.fixture=${JSON.stringify({ books, notes, cycles: [], writingTitle: state.writingTitle })}</script></body></html>`,
      });
    return r.abort();
  });
  await page.goto("https://library.test/");
  await page.addStyleTag({ path: "src/app/globals.css" });
  await page.addScriptTag({ content: bundle });
  await expect(page.locator(".wb-canvas-shell")).toBeVisible();
  return {
    state,
    calls,
    fail: () => {
      failSave = true;
    },
    allowSave: () => {
      failSave = false;
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

test("arrange packs visible notes, preserves connections and can undo the layout", async ({
  page,
}) => {
  const f = await mount(page, (state) => {
    connectedFixture(state);
    const key = `topic:${state.topics[0].id}::${state.notes[1].id}`;
    state.board.data.positions[key] = { x: 12000, y: 12000 };
  });
  const original = structuredClone(f.state.board.data),
    connections = structuredClone(f.state.connections);
  await page.getByRole("button", { name: "메모 정렬", exact: true }).click();
  await expect
    .poll(() => f.calls.filter((c) => c.type === "saveWhiteboard").length)
    .toBeGreaterThan(0);
  expect(f.state.connections).toEqual(connections);
  expect(f.state.board.data.links).toEqual(original.links);
  expect(f.state.board.data.filter).toEqual(original.filter);
  const key = `topic:${f.state.topics[0].id}::${f.state.notes[1].id}`;
  expect(f.state.board.data.positions[key].x).toBeLessThan(1000);
  expect(f.state.board.data.positions[key].y).toBeLessThan(1000);
  await page.getByRole("button", { name: "되돌리기", exact: true }).click();
  await expect
    .poll(() => f.state.board.data.positions[key])
    .toEqual(original.positions[key]);
});

test("hidden memos can be inspected and selectively restored in one batch without moving the board", async ({
  page,
}, testInfo) => {
  const f = await mount(page, (state) => {
    const data = emptyBoard();
    data.hiddenNoteIds = [
      state.notes[0].id,
      state.notes[1].id,
      state.notes[2].id,
    ];
    state.board = {
      id: "00000000-0000-4000-8000-000000000001",
      data,
      version: 1,
    };
  });
  const list = page.locator(".wb-hidden-notes");
  await page.evaluate(() => ((window as any).fixtureEditor = true));
  await expect(list).not.toHaveAttribute("open", "");
  await list.locator("summary").click();
  await list
    .getByRole("button", { name: "둘째 생각 세부정보", exact: true })
    .click();
  expect(await page.evaluate(() => (window as any).opened)).toBe(
    f.state.notes[1].id,
  );
  const detail = page.getByRole("dialog", { name: "기록 수정" });
  await expect(detail.locator('textarea[name="content"]')).toHaveValue(
    "두 번째 내 생각",
  );
  await detail.getByRole("button", { name: "닫기", exact: true }).click();
  await list
    .getByRole("checkbox", { name: "첫 생각 보이기 선택", exact: true })
    .check();
  await list
    .getByRole("checkbox", { name: "셋째 생각 보이기 선택", exact: true })
    .check();
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await list.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("hidden-notes.png"),
    fullPage: true,
  });
  const rejectRestore = async (r: any) => {
    if (r.request().postDataJSON().type === "setWhiteboardNotesVisibility")
      return r.fulfill({ status: 503, json: { error: "검수용 복원 실패" } });
    return r.fallback();
  };
  await page.route("**/api/knowledge", rejectRestore);
  await list
    .getByRole("button", { name: "선택한 메모 보이기", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("검수용 복원 실패");
  await expect(
    list.getByRole("checkbox", { name: "첫 생각 보이기 선택", exact: true }),
  ).toBeChecked();
  await page.unroute("**/api/knowledge", rejectRestore);
  const view = await page
    .locator(".wb-world")
    .evaluate((el) => (el as HTMLElement).style.transform);
  await list
    .getByRole("button", { name: "선택한 메모 보이기", exact: true })
    .click();
  await expect(
    list.getByRole("button", { name: "첫 생각 세부정보", exact: true }),
  ).toHaveCount(0);
  await expect(
    list.getByRole("button", { name: "둘째 생각 세부정보", exact: true }),
  ).toBeVisible();
  const writes = f.calls.filter(
    (c) => c.type === "setWhiteboardNotesVisibility",
  );
  expect(writes).toHaveLength(1);
  expect(writes[0].payload.noteIds.sort()).toEqual(
    [f.state.notes[0].id, f.state.notes[2].id].sort(),
  );
  expect(f.state.board.data.hiddenNoteIds).toEqual([f.state.notes[1].id]);
  expect(
    await page
      .locator(".wb-world")
      .evaluate((el) => (el as HTMLElement).style.transform),
  ).toBe(view);
  await expect(
    list.getByRole("button", { name: "선택한 메모 보이기", exact: true }),
  ).toBeDisabled();
  await list
    .getByRole("button", { name: "둘째 생각 세부정보", exact: true })
    .click();
  await detail.getByRole("button", { name: "보이기", exact: true }).click();
  await expect(list).toContainText("가려진 메모 · 0개");
  await detail.getByRole("button", { name: "닫기", exact: true }).click();
  expect(
    await page
      .locator(".wb-world")
      .evaluate((el) => (el as HTMLElement).style.transform),
  ).toBe(view);
});

for (const width of [390, 1280])
  test(`connection checkboxes apply selected or all connected memos and preserve individual viewing at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    const f = await mount(page, (state) => {
      connectedFixture(state);
      state.connections.push({
        ...state.connections[0],
        id: randomUUID(),
        source_id: state.notes[2].id,
        target_id: state.notes[3].id,
      });
    });
    const manager = page.locator(".wb-connection-list");
    await manager.locator(".wb-connection-counts").click();
    const selected = manager.getByRole("button", {
      name: "전체선택",
      exact: true,
    });
    const all = manager.getByRole("button", { name: "전체보기", exact: true });
    const first = manager.getByRole("checkbox", {
      name: "첫 생각 ↔ 둘째 생각 선택",
      exact: true,
    });
    const second = manager.getByRole("checkbox", {
      name: "셋째 생각 ↔ 신학 기록 선택",
      exact: true,
    });
    await expect(selected).toBeEnabled();
    await first.check();
    await expect(page.locator(".wb-note")).toHaveCount(2);
    await manager
      .getByRole("button", {
        name: "첫 생각 ↔ 둘째 생각 보드에서 보기",
        exact: true,
      })
      .click();
    await expect(page.locator(".wb-note")).toHaveCount(0);
    await expect(first).not.toBeChecked();
    await first.check();
    await second.check();
    await expect(selected).toHaveAttribute("aria-pressed", "true");
    await selected.click();
    await expect(page.locator(".wb-note")).toHaveCount(0);
    await expect(first).not.toBeChecked();
    await expect(second).not.toBeChecked();
    await selected.click();
    await expect(page.locator(".wb-note")).toHaveCount(4);
    await expect(page.locator(".wb-canvas-shell .wb-group")).toHaveCount(2);
    await expect
      .poll(() =>
        page.locator(".wb-viewport").evaluate((viewport) => {
          const bounds = viewport.getBoundingClientRect();
          return [...viewport.querySelectorAll(".wb-group")].every((group) => {
            const b = group.getBoundingClientRect();
            return (
              b.left >= bounds.left &&
              b.right <= bounds.right &&
              b.top >= bounds.top &&
              b.bottom <= bounds.bottom
            );
          });
        }),
      )
      .toBe(true);
    expect(
      await page
        .locator(".wb-note")
        .evaluateAll((nodes) =>
          nodes.map((n) => n.getAttribute("data-note-id")).sort(),
        ),
    ).toEqual(
      f.state.notes
        .slice(0, 4)
        .map((n: any) => n.id)
        .sort(),
    );
    await expect(manager).toHaveAttribute("open", "");
    await manager
      .getByRole("button", {
        name: "셋째 생각 ↔ 신학 기록 보드에서 보기",
        exact: true,
      })
      .click();
    await expect(page.locator(".wb-note")).toHaveCount(2);
    await expect(first).toBeChecked();
    await expect(second).not.toBeChecked();
    await all.click();
    await expect(page.locator(".wb-note")).toHaveCount(4);
    await first.uncheck();
    await expect(page.locator(".wb-note")).toHaveCount(2);
    expect(
      await page
        .locator(".wb-note")
        .evaluateAll((nodes) =>
          nodes.map((n) => n.getAttribute("data-note-id")).sort(),
        ),
    ).toEqual(
      f.state.notes
        .slice(2, 4)
        .map((n: any) => n.id)
        .sort(),
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await manager.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath("connection-selection.png"),
      fullPage: true,
    });
    expect(f.state.connections).toHaveLength(2);
    expect(
      f.calls.some(
        (c) =>
          c.type === "connectWhiteboardNotes" || c.type === "editConnection",
      ),
    ).toBe(false);
    f.state.connections = f.state.connections.map((c: any) => ({
      ...c,
      status: "rejected",
      version: c.version + 1,
    }));
    await page.evaluate(() => (window as any).refreshBoard());
    await expect(all).toBeDisabled();
    await expect(selected).toBeDisabled();
    await expect(page.locator(".wb-note")).toHaveCount(0);
  });

test("connection management reveals an editable memo group without creating extra relationships", async ({
  page,
}, testInfo) => {
  const f = await mount(page, connectedFixture);
  await page.locator(".wb-connection-counts").click();
  await page
    .getByRole("button", {
      name: "첫 생각 ↔ 둘째 생각 보드에서 보기",
      exact: true,
    })
    .click();
  await expect(page.locator(".wb-canvas-shell .wb-note")).toHaveCount(2);
  await expect(page.locator(".wb-canvas-shell .wb-group")).toHaveCount(1);
  const detail = page.getByRole("region", { name: "연결된 메모 내용" });
  await expect(detail.locator(".preserve-text:visible")).toHaveCount(0);
  await expect(detail.locator("select:visible")).toHaveCount(0);
  await expect(
    detail.locator(":scope > .memo-group-detail > .memo-group-note"),
  ).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("connection-group-compact.png"),
    fullPage: true,
  });
  await detail.locator(".memo-box-edge summary").first().click();
  await expect(detail.locator(".memo-box-edge .memo-group-note")).toHaveCount(
    2,
  );
  await detail.locator(".memo-group-note summary").first().click();
  await expect(detail).toContainText("본문에만 나오는 수용의 의미");
  await expect(detail).toContainText("두 번째 내 생각");
  await expect(
    detail.locator(".memo-group-note").first().locator(".preserve-text"),
  ).toBeVisible();
  await expect(
    detail.locator(".memo-group-note").nth(1).locator(".preserve-text"),
  ).not.toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("connection-group.png"),
    fullPage: true,
  });
  await detail
    .getByRole("combobox", { name: "관계", exact: true })
    .selectOption("supports");
  await detail
    .getByRole("textbox", { name: "연결 이유", exact: true })
    .fill("새 주장을 뒷받침한다");
  await detail.locator(".memo-box-edge summary").first().click();
  await expect(
    detail.getByRole("textbox", { name: "연결 이유", exact: true }),
  ).not.toBeVisible();
  await detail.locator(".memo-box-edge summary").first().click();
  await expect(
    detail.getByRole("textbox", { name: "연결 이유", exact: true }),
  ).toHaveValue("새 주장을 뒷받침한다");
  await detail
    .getByRole("button", { name: "연결 수정 저장", exact: true })
    .click();
  await expect
    .poll(() => f.state.connections[0].reason)
    .toBe("새 주장을 뒷받침한다");
  expect(f.state.connections[0].relation).toBe("supports");
  expect(f.state.connections).toHaveLength(1);
  expect(f.state.board.data.groups).toHaveLength(0);
  expect(f.calls.some((c) => c.type === "saveWhiteboard")).toBe(false);
  expect(f.calls.some((c) => c.type === "connectWhiteboardNotes")).toBe(false);
  await page
    .getByRole("button", { name: "전체 보드 보기", exact: true })
    .click();
  await expect(page.locator(".wb-canvas-shell .wb-note")).toHaveCount(5);
});
for (const seeded of [false, true])
  test(`hiding in the shared editor preserves placements, camera and scroll (${seeded ? "saved" : "legacy"} layout)`, async ({
    page,
  }) => {
    const f = await mount(page, (state) => {
      const data = emptyBoard();
      data.filter.topics = [state.topics[0].id];
      if (seeded)
        state.notes.slice(0, 3).forEach((n: any, i: number) => {
          data.positions[`note::${n.id}`] = { x: 40 + i * 245, y: 60 };
        });
      state.board = {
        id: "00000000-0000-4000-8000-000000000001",
        version: 1,
        data,
      };
    });
    await page.evaluate(() => {
      (window as any).fixtureEditor = true;
      const top = document.createElement("div");
      top.style.height = "650px";
      document.body.prepend(top);
      const bottom = document.createElement("div");
      bottom.style.height = "900px";
      document.body.append(bottom);
    });
    const opener = page.getByRole("button", {
      name: "첫 생각 열기",
      exact: true,
    });
    await opener.scrollIntoViewIfNeeded();
    await page.getByRole("button", { name: "축소", exact: true }).click();
    await opener.scrollIntoViewIfNeeded();
    const beforePan = await page
      .locator(".wb-world")
      .evaluate((el) => (el as HTMLElement).style.transform);
    await page
      .locator(".wb-viewport")
      .dispatchEvent("wheel", { deltaX: -35, deltaY: -35, cancelable: true });
    await expect
      .poll(() =>
        page
          .locator(".wb-world")
          .evaluate((el) => (el as HTMLElement).style.transform),
      )
      .not.toBe(beforePan);
    const original = await page.evaluate(() => ({
      scroll: window.scrollY,
      view: (document.querySelector(".wb-world") as HTMLElement).style
        .transform,
      nodes: [...document.querySelectorAll(".wb-note")].map((el) => ({
        id: el.getAttribute("data-note-id"),
        left: (el as HTMLElement).style.left,
        top: (el as HTMLElement).style.top,
      })),
    }));
    await opener.click();
    const dialog = page.getByRole("dialog", { name: "기록 수정" });
    await dialog.getByRole("button", { name: "가리기", exact: true }).click();
    await expect
      .poll(
        () =>
          f.calls.filter((c) => c.type === "setWhiteboardNoteVisibility")
            .length,
      )
      .toBe(1);
    await expect(
      page.locator(`.wb-note[data-note-id="${f.state.notes[0].id}"]`),
    ).toHaveCount(0);
    expect(await page.evaluate(() => window.scrollY)).toBeCloseTo(
      original.scroll,
      0,
    );
    expect(
      await page
        .locator(".wb-world")
        .evaluate((el) => (el as HTMLElement).style.transform),
    ).toBe(original.view);
    const remaining = await page.locator(".wb-note").evaluateAll((els) =>
      els.map((el) => ({
        id: el.getAttribute("data-note-id"),
        left: (el as HTMLElement).style.left,
        top: (el as HTMLElement).style.top,
      })),
    );
    expect(remaining).toEqual(
      original.nodes.filter((n) => n.id !== f.state.notes[0].id),
    );
    await dialog.getByRole("button", { name: "보이기", exact: true }).click();
    await expect(
      page.locator(`.wb-note[data-note-id="${f.state.notes[0].id}"]`),
    ).toHaveCount(1);
    expect(
      await page.locator(".wb-note").evaluateAll((els) =>
        els.map((el) => ({
          id: el.getAttribute("data-note-id"),
          left: (el as HTMLElement).style.left,
          top: (el as HTMLElement).style.top,
        })),
      ),
    ).toEqual(original.nodes);
    expect(
      await page
        .locator(".wb-world")
        .evaluate((el) => (el as HTMLElement).style.transform),
    ).toBe(original.view);
    await dialog.getByRole("button", { name: "닫기", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.scrollY))
      .toBeCloseTo(original.scroll, 0);
    expect(f.calls.some((c) => c.type === "editNote")).toBe(false);
  });

for (const afterSave of [false, true])
  test(`visibility-only refresh merges into a pending layout without moving the camera (${afterSave ? "after acknowledgement" : "initial"})`, async ({
    page,
  }) => {
    const f = await mount(page, (state) => {
      state.board = {
        id: "00000000-0000-4000-8000-000000000001",
        version: 1,
        data: emptyBoard(),
      };
    });
    if (afterSave) {
      await page
        .getByRole("button", { name: "메모 정렬", exact: true })
        .click();
      await expect(page.getByText("저장됨", { exact: true })).toBeVisible();
    }
    await page.clock.install({ time: new Date("2026-10-27T00:00:00Z") });
    await page.clock.pauseAt(new Date("2026-10-27T00:00:01Z"));
    await page.getByRole("button", { name: "메모 정렬", exact: true }).click();
    const view = await page
      .locator(".wb-world")
      .evaluate((el) => (el as HTMLElement).style.transform);
    f.state.board = {
      ...f.state.board,
      version: afterSave ? 3 : 2,
      data: { ...f.state.board.data, hiddenNoteIds: [f.state.notes[0].id] },
    };
    await page.evaluate(() => (window as any).flushBoard());
    await page.clock.runFor(200);
    await expect(page.getByText("4개 메모", { exact: true })).toBeVisible();
    await expect(
      page.getByText("다른 곳에서 배치가 변경되었습니다.", { exact: false }),
    ).toHaveCount(0);
    expect(
      await page
        .locator(".wb-world")
        .evaluate((el) => (el as HTMLElement).style.transform),
    ).toBe(view);
    await page.clock.runFor(350);
    await expect
      .poll(() => f.calls.filter((c) => c.type === "saveWhiteboard").length)
      .toBe(afterSave ? 2 : 1);
    const saved = f.calls.filter((c) => c.type === "saveWhiteboard").at(-1);
    expect(saved.payload.expectedVersion).toBe(afterSave ? 3 : 2);
    expect(saved.payload.data.hiddenNoteIds).toEqual([f.state.notes[0].id]);
    await expect(
      page.getByRole("button", { name: "현재 배치로 저장", exact: true }),
    ).toHaveCount(0);
  });

test("layout undo keeps visibility changed by another note editor", async ({
  page,
}) => {
  const f = await mount(page, connectedFixture);
  await page.getByRole("button", { name: "메모 정렬", exact: true }).click();
  await expect
    .poll(() => f.calls.filter((c) => c.type === "saveWhiteboard").length)
    .toBe(1);
  f.state.board = {
    ...f.state.board,
    version: f.state.board.version + 1,
    data: { ...f.state.board.data, hiddenNoteIds: [f.state.notes[0].id] },
  };
  await page.evaluate(() => (window as any).refreshBoard());
  await expect(page.getByText("4개 메모", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "되돌리기", exact: true }).click();
  await expect
    .poll(() => f.calls.filter((c) => c.type === "saveWhiteboard").length)
    .toBe(2);
  expect(f.state.board.data.hiddenNoteIds).toEqual([f.state.notes[0].id]);
  await expect(
    page.locator(`.wb-note[data-note-id="${f.state.notes[0].id}"]`),
  ).toHaveCount(0);
  expect(f.state.notes).toHaveLength(5);
});

test("all whiteboard facets keep two selected choices until Search", async ({
  page,
}) => {
  const f = await mount(page);
  const choices: Record<string, string[]> = {
    주제: ["정서", "신학"],
    태그: ["상담", "철학"],
    분야: ["철학·심리학", "종교"],
    도서: ["상담 도서 · 상담 저자", "신학 도서 · 신학 저자"],
  };
  for (const [label, values] of Object.entries(choices)) {
    for (const value of values) await choose(page, label, value);
    await expect(
      page.getByRole("button", { name: `${label} 선택`, exact: true }),
    ).toContainText("2개 선택");
    await page
      .getByRole("button", { name: `${label} 선택 완료`, exact: true })
      .click();
  }
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect
    .poll(() => f.state.board?.data.filter)
    .toMatchObject({
      topics: f.state.topics.map((t: any) => t.id),
      tags: ["상담", "철학"],
      categories: ["100", "200"],
      books: f.state.books.map((b: any) => b.id),
    });
});

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

test("coincident note and group lines expose both relationship types", async ({
  page,
}) => {
  const f = await mount(page, (state) => {
    collapsedConnections(state);
    const [a, b] = state.topics.map((t: any) => `topic:${t.id}`);
    state.board.data.groupPositions[a] = { x: 30, y: 30 };
    state.board.data.groupPositions[b] = { x: 30, y: 350 };
    state.board.data.links = [{ source: a, target: b }];
  });
  await page.getByRole("button", { name: "묶음 연결선", exact: true }).click();
  const actions = page.getByRole("group", { name: "선택한 연결", exact: true });
  await expect(
    actions.getByRole("button", { name: "메모 연결 보기", exact: true }),
  ).toBeVisible();
  await actions
    .getByRole("button", { name: "묶음 연결 보기", exact: true })
    .click();
  await actions.getByRole("button", { name: "끊기", exact: true }).click();
  await expect.poll(() => f.state.board.data.links.length).toBe(0);
  expect(f.state.connections.every((c: any) => c.status === "accepted")).toBe(
    true,
  );
});

test("failed group unlink preserves the selected line and can retry", async ({
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
  const line = page.getByRole("button", { name: "묶음 연결선", exact: true });
  await line.click();
  const actions = page.getByRole("group", { name: "선택한 연결", exact: true });
  f.fail();
  await actions.getByRole("button", { name: "끊기", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("검수용 저장 실패");
  await expect(line).toBeVisible();
  await expect(actions).toBeVisible();
  expect(f.state.board.data.links).toHaveLength(1);
  f.allowSave();
  await actions.getByRole("button", { name: "끊기", exact: true }).click();
  await expect(line).toHaveCount(0);
  await expect.poll(() => f.state.board.data.links.length).toBe(0);
});

test("keyboard toggling cannot restore a group link during unlink save", async ({
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
  const release = f.holdSave();
  await page.getByRole("button", { name: "묶음 연결선", exact: true }).click();
  await page
    .getByRole("group", { name: "선택한 연결", exact: true })
    .getByRole("button", { name: "끊기", exact: true })
    .click();
  await expect
    .poll(() => f.calls.filter((c) => c.type === "saveWhiteboard").length)
    .toBe(1);
  const toggle = page.getByRole("button", { name: "정서 펼치기", exact: true });
  await toggle.focus();
  await toggle.press("Enter");
  await expect(toggle).toBeVisible();
  release();
  await expect(
    page.getByRole("button", { name: "묶음 연결선", exact: true }),
  ).toHaveCount(0);
  expect(f.state.board.data.links).toHaveLength(0);
  expect(f.state.board.data.collapsed).toHaveLength(2);
  await page.getByRole("button", { name: "되돌리기", exact: true }).click();
  await expect
    .poll(() => f.calls.filter((c) => c.type === "saveWhiteboard").length)
    .toBe(2);
  expect(
    f.calls
      .filter((c) => c.type === "saveWhiteboard")
      .map((c) => c.payload.data.links.length),
  ).toEqual([0, 1]);
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
    expect((await actions.boundingBox())!.width).toBeLessThanOrEqual(320);
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
test("successive memo searches accumulate without duplicates and clear removes all displayed memos", async ({
  page,
}) => {
  const f = await mount(page);
  const search = page.getByRole("searchbox", {
    name: "메모 제목·내용 검색",
    exact: true,
  });
  await search.fill("수용");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect(page.locator(".wb-note")).toHaveCount(1);
  await search.fill("신학");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect(page.locator(".wb-note")).toHaveCount(2);
  expect(
    new Set(
      await page
        .locator(".wb-note")
        .evaluateAll((els) => els.map((n) => n.getAttribute("data-note-id"))),
    ).size,
  ).toBe(2);
  expect(
    await page.locator(".wb-note").evaluateAll((els) => {
      const boxes = els.map((n) => n.getBoundingClientRect());
      return boxes.every((a, i) =>
        boxes
          .slice(i + 1)
          .every(
            (b) =>
              a.right <= b.left ||
              b.right <= a.left ||
              a.bottom <= b.top ||
              b.bottom <= a.top,
          ),
      );
    }),
  ).toBe(true);
  await page.getByRole("button", { name: "지우기", exact: true }).click();
  await expect(page.locator(".wb-note")).toHaveCount(0);
  await expect(search).toHaveValue("");
  await expect.poll(() => f.state.board?.data.searchNoteIds).toEqual([]);
  await search.fill("수용");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect(page.locator(".wb-note")).toHaveCount(1);
});
test("searchable multi-facets apply only on search and search the complete note body", async ({
  page,
}) => {
  const f = await mount(page);
  await choose(page, "태그", "상담");
  await choose(page, "태그", "철학");
  await page
    .getByRole("searchbox", { name: "메모 제목·내용 검색" })
    .fill("수용");
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
    .getByRole("searchbox", { name: "메모 제목·내용 검색", exact: true })
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
    page.getByRole("searchbox", { name: "메모 제목·내용 검색", exact: true }),
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
  await expect.poll(() => f.state.board?.data.links.length ?? 0).toBe(1);
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
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "This touch protocol test requires Chromium CDP; other pointer and facet cases run in both browsers.",
  );
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
  // Explicit searches now persist their cumulative note IDs separately from
  // the picker state. Replace both parts of this authoritative snapshot.
  f.state.board.data.searchNoteIds = [f.state.notes[3].id];
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
  await page.locator(".wb-connection-counts").click();
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
    .getByRole("searchbox", { name: "메모 제목·내용 검색", exact: true })
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

test("writing topic search restores explicitly searched removed notes while preserving other exclusions", async ({
  page,
}) => {
  const f = await mount(page, (state) => {
    state.writingTitle = "교회회복 글감";
    state.topics[0].name = "교회회복";
    state.memberships = [0, 1].map((i) => ({
      topicId: state.topics[0].id,
      sourceKind: "note",
      sourceId: state.notes[i].id,
      status: "accepted",
    }));
    state.board = {
      id: "00000000-0000-4000-8000-000000000001",
      version: 1,
      data: {
        ...emptyBoard(),
        searchNoteIds: [],
        writing: {
          chapters: [],
          excludedNoteIds: [
            state.notes[0].id,
            state.notes[1].id,
            state.notes[4].id,
          ],
        },
      },
    };
  });
  await choose(page, "주제", "교회회복");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  for (const note of f.state.notes.slice(0, 2))
    await expect(
      page.locator(`.wb-note[data-note-id="${note.id}"]`),
    ).toHaveCount(1);
  await expect
    .poll(() => f.state.board.data.writing.excludedNoteIds)
    .toEqual([f.state.notes[4].id]);
  expect(f.state.board.data.hiddenNoteIds).toEqual([]);
  expect(f.state.notes).toHaveLength(5);
});
