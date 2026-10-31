import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import {
  buildScene,
  emptyBoard,
  NOTE_HEIGHT,
  NOTE_WIDTH,
} from "../src/lib/whiteboard";
import { referenceThoughtBox } from "../src/lib/shared-thought-boxes";

let script: string;
test.beforeAll(async () => {
  script = (
    await build({
      stdin: {
        contents: `import{createRoot}from'react-dom/client';import{useState}from'react';import{KnowledgePanel}from'./src/components/knowledge-panel';import{ThoughtBoxes}from'./src/components/memo-box/thought-boxes';import{WhiteboardCanvas}from'./src/components/whiteboard/canvas';
const noop=()=>{};function Fixture(){const[board,setBoard]=useState(window.fixture.board.data);return window.mode==='menu'?<KnowledgePanel library={window.library} ownerId="display" onOpen={noop}/>:<section className="knowledge-panel">{window.mode==='bundles'?<ThoughtBoxes onOpen={(kind,id)=>window.opened={kind,id}}/>:<WhiteboardCanvas source={window.fixture} suppliedScene={window.fixture.suppliedScene} board={board} fitKey="display" numbered busy={false} selectedNote={null} selectedGroup={null} onDrop={noop} onGroupDrop={noop} onToggle={noop} onOpen={noop} onSelectNote={noop} onSelectGroup={noop} onSelectLine={noop} onRemoveConnection={async()=>{}} onRemoveGroupConnection={noop} onArrange={noop} onNoteOrder={(chapterId,itemId,order)=>setBoard(old=>({...old,writing:{...old.writing,chapters:old.writing.chapters.map(c=>c.id===chapterId?{...c,items:c.items.map(i=>i.id===itemId?{...i,order}:i)}:c)}}))}/>}</section>};createRoot(document.getElementById('root')).render(<Fixture/>);`,
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

async function mount(
  page: Page,
  mode: "menu" | "bundles" | "numbers",
  suppliedScene = false,
) {
  const note = {
    id: crypto.randomUUID(),
    title: "컴퓨터의 위험",
    content: "컴퓨터가 생각과 생활에 미치는 영향을 살펴본 원문 메모입니다.",
    tags: [],
  };
  const bundle = {
    id: crypto.randomUUID(),
    title: "기술에 관한 생각",
    description: "생각묶음의 정리",
    note_ids: [note.id],
    version: 1,
    archived_at: null,
  };
  const source: any = {
    notes: [note],
    books: [],
    topics: [],
    memberships: [],
    connections: [],
    bundles: [bundle],
    bundleLinks: [],
  };
  const board = referenceThoughtBox(emptyBoard(), bundle, source);
  board.writing!.viewport = { x: 0, y: 0, zoom: 1 };
  board.writing!.chapters[0].items[0].order = 100000;
  source.board = { id: crypto.randomUUID(), version: 1, data: board };
  if (suppliedScene) {
    const other = { ...note, id: crypto.randomUUID(), title: "다음 메모" };
    source.notes.push(other);
    source.connections.push({
      id: crypto.randomUUID(),
      source_kind: "note",
      target_kind: "note",
      source_id: note.id,
      target_id: other.id,
      status: "accepted",
      relation: "related",
    });
    source.suppliedScene = buildScene(source, board);
    const first = source.suppliedScene.nodes.find(
      (n: { noteId: string }) => n.noteId === note.id,
    );
    first.x = 280;
    first.y = 220;
    source.suppliedScene.nodes.push({
      ...first,
      id: "second-occurrence",
      x: 800,
      y: 400,
    });
  }
  await page.route("https://display.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/whiteboard") return route.fulfill({ json: source });
    if (path === "/api/thought-boxes")
      return route.fulfill({
        json: { items: [{ id: bundle.id, title: bundle.title, noteCount: 1 }] },
      });
    if (path === "/api/knowledge")
      return route.fulfill({
        json: { research: [], items: [], placements: [] },
      });
    if (path.startsWith("/api/"))
      return route.fulfill({ json: { items: [], total: 0 } });
    return route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html lang="ko"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>',
    });
  });
  await page.goto("https://display.test/");
  await page.evaluate(
    ({ source, mode }) => {
      Object.assign(window, {
        fixture: source,
        mode,
        library: { notes: [], books: [], cycles: [] },
      });
      localStorage.setItem("library:memo-box-tab:display", "bundles");
    },
    { source, mode },
  );
  await page.addStyleTag({ path: "src/app/globals.css" });
  await page.addScriptTag({ content: script, type: "module" });
  return { note, bundle };
}

test("knowledge tabs show memo box, whiteboard, then writing bundles and retain the writing key", async ({
  page,
}) => {
  await mount(page, "menu");
  const tabs = page.locator(".knowledge-panel > .knowledge-tabs > button");
  await expect(tabs).toHaveText([
    "메모 상자",
    "화이트보드",
    "글감묶음",
    "사용법",
  ]);
  await tabs.nth(2).click();
  await expect(tabs.nth(2)).toHaveClass("primary");
  expect(
    await page.evaluate(() =>
      localStorage.getItem("library:knowledge-tab:display"),
    ),
  ).toBe("writing");
  await mount(page, "menu");
  await expect(
    page.getByRole("button", { name: "글감묶음", exact: true }),
  ).toHaveClass("primary");
});

test("canvas uses supplied scene geometry and keeps it while zooming", async ({
  page,
}) => {
  const { note } = await mount(page, "numbers", true);
  const cards = page.locator(`.wb-note[data-note-id="${note.id}"]`);
  await expect(cards).toHaveCount(2);
  const card = cards.first();
  await expect(card).toHaveCSS("left", "280px");
  await expect(card).toHaveCSS("top", "220px");
  const line = page.locator(".wb-line-draw");
  await expect(line).toHaveAttribute("x1", String(280 + NOTE_WIDTH / 2));
  await expect(line).toHaveAttribute("y1", String(220 + NOTE_HEIGHT / 2));
  const box = (await card.boundingBox())!;
  await page.mouse.move(box.x + 100, box.y + 55);
  await page.mouse.down();
  await page.mouse.move(box.x + 130, box.y + 75);
  await expect(line).toHaveAttribute("x1", String(310 + NOTE_WIDTH / 2));
  await expect(line).toHaveAttribute("y1", String(240 + NOTE_HEIGHT / 2));
  await page.mouse.up();
  await page.getByRole("button", { name: "축소", exact: true }).click();
  await expect(page.locator(".wb-zoom span")).toHaveText("90%");
  await expect(card).toHaveCSS("left", "280px");
  await expect(card).toHaveCSS("top", "220px");
});

for (const width of [390, 1280]) {
  test(`shared original memo title spans the content width at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 850 });
    const { note, bundle } = await mount(page, "bundles");
    await page
      .getByRole("button", { name: `${bundle.title} 1개 메모` })
      .click();
    const title = page.locator(".thought-box-note > button");
    await expect(title).toHaveText(note.title);
    await page.screenshot({
      path: info.outputPath(`shared-title-${width}.png`),
    });
    const layout = await title.evaluate((el) => {
      const rect = el.getBoundingClientRect(),
        article = el.closest("article")!.getBoundingClientRect(),
        content = el.nextElementSibling!.getBoundingClientRect(),
        text = document.createRange();
      text.selectNodeContents(el);
      return {
        width: rect.width,
        articleWidth: article.width,
        lines: text.getClientRects().length,
        contentBelow: content.top >= rect.bottom,
      };
    });
    expect(layout.width).toBeGreaterThan(layout.articleWidth - 2);
    expect(layout.lines).toBe(1);
    expect(layout.contentBelow).toBe(true);
    await title.click();
    expect(await page.evaluate(() => (window as any).opened)).toEqual({
      kind: "note",
      id: note.id,
    });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
  });

  test(`memo order remains readable and editable in the integrated panel at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 850 });
    await mount(page, "numbers");
    const order = page.locator(".wb-note-order");
    await expect(order).toHaveValue("100000");
    await page.screenshot({ path: info.outputPath(`memo-order-${width}.png`) });
    const layout = await order.evaluate((el) => {
      const input = el as HTMLInputElement,
        style = getComputedStyle(input),
        measure = document.createElement("canvas").getContext("2d")!;
      measure.font = style.font;
      return {
        contentWidth:
          input.clientWidth -
          parseFloat(style.paddingLeft) -
          parseFloat(style.paddingRight),
        textWidth: measure.measureText(input.value).width,
        contentHeight:
          input.clientHeight -
          parseFloat(style.paddingTop) -
          parseFloat(style.paddingBottom),
        lineHeight: parseFloat(style.lineHeight),
        appearance: style.appearance,
      };
    });
    expect(layout.contentWidth).toBeGreaterThanOrEqual(layout.textWidth);
    expect(layout.contentHeight).toBeGreaterThanOrEqual(layout.lineHeight);
    expect(layout.appearance).toBe("textfield");
    await expect(page.locator(".wb-note-heading .wb-entry-badge")).toHaveCount(
      0,
    );
    await order.fill("12");
    await expect(order).toHaveValue("12");
    await order.press("ArrowUp");
    await expect(order).toHaveValue("13");
    await page.getByRole("button", { name: "전체화면", exact: true }).click();
    await expect(order).toBeVisible();
    await page.screenshot({
      path: info.outputPath(`memo-order-fullscreen-${width}.png`),
    });
  });
}
