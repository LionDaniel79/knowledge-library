import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { emptyBoard, WHITEBOARD_ID } from "../src/lib/whiteboard";
import {
  referenceThoughtBox,
  sharedBoxSummaries,
  planThoughtBoxPromotion,
} from "../src/lib/shared-thought-boxes";
import { addThoughtBox } from "../src/lib/thought-boxes";
let script: string, css: string;
test.beforeAll(async () => {
  script = (
    await build({
      stdin: {
        contents: `import{createRoot}from'react-dom/client';import{WhiteboardPanel}from'./src/components/whiteboard/panel';import{ThoughtBoxes}from'./src/components/memo-box/thought-boxes';const root=createRoot(document.getElementById('root'));window.mount=(mode)=>root.render(mode==='menu'?<ThoughtBoxes onOpen={()=>{}}/>:<WhiteboardPanel key={mode} library={{notes:window.fixture.notes,books:[],cycles:[]}} ownerId='shared-fixture' boardId={mode==='writing'?window.projectId:window.defaultId} writingTitle={mode==='writing'?'글감':undefined} onOpen={(kind,id,anchor)=>{window.opened={kind,id,anchor}}}/>);window.mount(window.mode);`,
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
  css = await readFile("src/app/globals.css", "utf8");
});
async function setup(
  page: Page,
  mode = "writing",
  legacy: boolean | "conflict" = false,
) {
  const ids = [randomUUID(), randomUUID(), randomUUID()],
    projectId = randomUUID();
  const bundles = [
    {
      id: randomUUID(),
      title: "첫 생각묶음",
      description: "공유 정리",
      note_ids: ids.slice(0, 2),
      version: 1,
      archived_at: null,
    },
    {
      id: randomUUID(),
      title: "둘째 생각묶음",
      description: "추가 정리",
      note_ids: [ids[2]],
      version: 1,
      archived_at: null,
    },
  ];
  const source: any = {
    notes: ids.map((id, i) => ({
      id,
      title: `메모${i + 1}`,
      content: `원문${i + 1}`,
      tags: [],
    })),
    books: [],
    topics: [],
    memberships: [],
    connections: [],
    bundles,
    bundleLinks: [],
  };
  const boards = new Map<string, any>();
  let data = legacy
    ? addThoughtBox(emptyBoard(), bundles[0].id, "첫 생각묶음")
    : referenceThoughtBox(emptyBoard(), bundles[0], source);
  if (legacy === "conflict")
    data.writing!.chapters[0].items = ids.map((id, i) => ({
      id: randomUUID(),
      order: i + 1,
      kind: "note",
      label: "메모",
      noteIds: [id],
      groupIds: [],
    }));
  data.hiddenNoteIds = [ids[0]];
  boards.set(WHITEBOARD_ID, {
    id: WHITEBOARD_ID,
    data: structuredClone(data),
    version: 1,
  });
  data.writing = { ...data.writing!, excludedNoteIds: [] };
  data.writing.chapters[0].order = 7;
  data.writing.chapters[0].items.forEach((i, index) => (i.order = index + 3));
  data.writing.chapters[0].width = 2200;
  data.writing.chapters[0].height = 10000;
  boards.set(projectId, { id: projectId, data, version: 1 });
  if (legacy === true) source.bundles = [];
  const calls: any[] = [];
  let release: () => void = () => {},
    delay = false;
  await page.route("**/*", async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === "/api/thought-boxes") {
      const plan = planThoughtBoxPromotion(
        [...boards.values()],
        source.bundles,
      );
      return route.fulfill({
        json: {
          items: sharedBoxSummaries(source.bundles),
          pendingLegacy:
            legacy &&
            !boards.get(WHITEBOARD_ID).data.writing.chapters[0].bundleId,
          legacyConflicts: plan.conflicts,
          legacyToken: plan.legacyToken,
        },
      });
    }
    if (u.pathname === "/api/whiteboard")
      return route.fulfill({
        json: {
          ...source,
          board: boards.get(u.searchParams.get("boardId") ?? WHITEBOARD_ID),
        },
      });
    if (u.pathname === "/api/knowledge") {
      const c = route.request().postDataJSON(),
        p = c.payload;
      calls.push(c);
      if (c.type === "editConnection") {
        const old = source.connections.find((value: any) => value.id === p.id);
        if (!old || old.version !== p.expectedVersion)
          return route.fulfill({ status: 409, json: { error: "연결 변경" } });
        Object.assign(old, p, { version: old.version + 1 });
        return route.fulfill({ json: { id: old.id, version: old.version } });
      }
      if (c.type === "promoteThoughtBoxes") {
        const plan = planThoughtBoxPromotion(
          [...boards.values()],
          source.bundles,
          p.legacyToken,
        );
        if (plan.conflicts.length && p.legacyToken !== plan.legacyToken)
          return route.fulfill({
            status: 409,
            json: { error: "추가 메모 확인" },
          });
        source.bundles = plan.bundles;
        for (const b of plan.boards)
          boards.set(b.id, { ...b, version: b.version + 1 });
        return route.fulfill({ json: { count: plan.created.length } });
      }
      if (c.type === "saveWhiteboard") {
        const old = boards.get(p.boardId ?? WHITEBOARD_ID);
        expect(p.expectedVersion).toBe(old?.version ?? 0);
        boards.set(p.boardId ?? WHITEBOARD_ID, {
          id: p.boardId ?? WHITEBOARD_ID,
          data: p.data,
          version: (old?.version ?? 0) + 1,
        });
        return route.fulfill({ json: { version: (old?.version ?? 0) + 1 } });
      }
      if (c.type === "saveMemoBundle") {
        if (delay) {
          delay = false;
          await new Promise<void>((r) => (release = r));
        }
        const b = source.bundles.find((b: any) => b.id === p.id);
        if (b) {
          if (b.version !== p.expectedVersion)
            return route.fulfill({
              status: 409,
              json: { error: "원본이 변경되었습니다" },
            });
          Object.assign(b, {
            title: p.title,
            description: p.description,
            note_ids: p.noteIds,
            version: b.version + 1,
          });
          return route.fulfill({ json: { id: b.id, version: b.version } });
        }
        const next = {
          id: randomUUID(),
          title: p.title,
          description: p.description,
          note_ids: p.noteIds,
          version: 1,
          archived_at: null,
        };
        source.bundles.push(next);
        return route.fulfill({ json: { id: next.id, version: 1 } });
      }
      return route.fulfill({
        status: 400,
        json: { error: "Unexpected command " + c.type },
      });
    }
    return route.fulfill({
      contentType: "text/html",
      body: '<html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>',
    });
  });
  await page.goto("https://shared.test/");
  await page.addStyleTag({ content: css });
  await page.evaluate(
    ({ source, projectId, defaultId, mode }) =>
      Object.assign(window, { fixture: source, projectId, defaultId, mode }),
    { source, projectId, defaultId: WHITEBOARD_ID, mode },
  );
  await page.addScriptTag({ content: script, type: "module" });
  return {
    source,
    boards,
    ids,
    bundles,
    projectId,
    calls,
    delayNext() {
      delay = true;
    },
    release() {
      release();
    },
  };
}
test("selection displays a shared original once and editing it propagates while local numbering remains", async ({
  page,
}) => {
  const f = await setup(page);
  await page.locator(".wb-connection-list summary").click();
  await expect(page.locator(".wb-connection-counts")).toContainText(
    "생각 묶음 2",
  );
  await page.getByLabel("둘째 생각묶음 생각 묶음 선택").check();
  await page.getByRole("button", { name: "선택보기", exact: true }).click();
  await expect(page.locator(".writing-chapter")).toHaveCount(2);
  await page.getByRole("button", { name: "선택보기", exact: true }).click();
  await expect(page.locator(".writing-chapter")).toHaveCount(2);
  expect(f.source.bundles).toHaveLength(2);
  await page.getByLabel("목차 제목").first().fill("함께 바뀐 원본");
  await expect.poll(() => f.source.bundles[0].title).toBe("함께 바뀐 원본");
  await page.evaluate(() => (window as any).mount("whiteboard"));
  await expect(page.getByLabel("상자 제목").first()).toHaveValue(
    "함께 바뀐 원본",
  );
  expect(f.boards.get(f.projectId).data.writing.chapters[0].order).toBe(7);
});
test("writing numbers are visible, loose removal is local, arrange sizes boxes and general hide is independent", async ({
  page,
}) => {
  const f = await setup(page);
  await expect(page.locator(".wb-note-order").nth(0)).toHaveValue("3");
  await expect(page.locator(".wb-note-order").nth(1)).toHaveValue("4");
  await expect(
    page.getByRole("article", { name: "메모 메모1", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".wb-hidden-notes")).toHaveCount(0);
  await page.getByRole("button", { name: "메모 정렬", exact: true }).click();
  await page.getByRole("button", { name: "메모3 글감 보드에서 빼기" }).click();
  await expect(
    page.getByRole("article", { name: "메모 메모3", exact: true }),
  ).toHaveCount(0);
  expect(f.source.notes).toHaveLength(3);
  await page.getByRole("button", { name: "메모 정렬", exact: true }).click();
  await expect
    .poll(() => f.boards.get(f.projectId).data.writing.chapters[0].width)
    .toBeLessThan(1000);
  await expect
    .poll(() => f.boards.get(f.projectId).data.writing.chapters[0].height)
    .toBeLessThan(1000);
  await page.getByRole("button", { name: "메모1 열기", exact: true }).click();
  expect(
    await page.evaluate(() => (window as any).opened.anchor.whiteboardId),
  ).toBe(WHITEBOARD_ID);
  expect(f.boards.get(WHITEBOARD_ID).data.hiddenNoteIds).toEqual([f.ids[0]]);
});
test("canonical menu lists titles without ordering controls and saves the original only", async ({
  page,
}) => {
  const f = await setup(page, "menu");
  await page
    .getByRole("button", { name: "첫 생각묶음 2개 메모", exact: true })
    .click();
  await expect(page.getByRole("spinbutton")).toHaveCount(0);
  await expect(page.locator(".thought-box-list")).not.toContainText("7.");
  await page.getByLabel("생각묶음 제목").fill("원본 편집");
  await page.getByRole("button", { name: "원본 저장" }).click();
  await expect.poll(() => f.source.bundles[0].title).toBe("원본 편집");
  expect(f.calls.some((c) => c.type === "saveWhiteboard")).toBe(false);
});
test("slow canonical saves preserve edits typed while a previous response is in flight", async ({
  page,
}) => {
  const f = await setup(page);
  f.delayNext();
  await page.getByLabel("목차 제목").fill("첫 요청");
  await expect
    .poll(() => f.calls.filter((c) => c.type === "saveMemoBundle").length)
    .toBe(1);
  await page.getByLabel("목차 제목").fill("마지막 입력");
  f.release();
  await expect.poll(() => f.source.bundles[0].title).toBe("마지막 입력");
  await expect(page.getByLabel("목차 제목")).toHaveValue("마지막 입력");
});

test("renumbering a writing memo never changes canonical membership order", async ({
  page,
}) => {
  const f = await setup(page);
  await page.getByLabel("메모1 순서").fill("9");
  await page.getByLabel("메모2 순서").fill("1");
  await expect
    .poll(
      () =>
        f.boards
          .get(f.projectId)
          .data.writing.chapters[0].items.find(
            (i: any) => i.noteIds[0] === f.ids[1],
          ).order,
    )
    .toBe(1);
  expect(f.source.bundles[0].note_ids).toEqual(f.ids.slice(0, 2));
  expect(f.calls.filter((c) => c.type === "saveMemoBundle")).toHaveLength(0);
});
test("a fresh external canonical version can be edited after an earlier local save", async ({
  page,
}) => {
  const f = await setup(page);
  await page.getByLabel("목차 제목").fill("첫 저장");
  await expect.poll(() => f.source.bundles[0].version).toBe(2);
  await expect.poll(() => f.boards.get(f.projectId).version).toBeGreaterThan(1);
  Object.assign(f.source.bundles[0], { version: 3, title: "다른 기기 수정" });
  await page.evaluate(() => {
    (window as any).fixture.notes = [...(window as any).fixture.notes];
    (window as any).mount("writing");
  });
  await expect(page.getByLabel("목차 제목")).toHaveValue("다른 기기 수정");
  await page.getByLabel("목차 제목").fill("최근 원본에 편집");
  await expect.poll(() => f.source.bundles[0].title).toBe("최근 원본에 편집");
  expect(
    f.calls.filter((c) => c.type === "saveMemoBundle").at(-1).payload
      .expectedVersion,
  ).toBe(3);
});
test("undo restores shared original content as well as board layout", async ({
  page,
}) => {
  const f = await setup(page);
  await page.getByRole("button", { name: "메모1 상자에서 빼기" }).click();
  await expect(
    page.locator(".wb-note[data-chapter-note-id]").filter({ hasText: "메모1" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "되돌리기", exact: true }).click();
  await expect(
    page.locator(".wb-note[data-chapter-note-id]").filter({ hasText: "메모1" }),
  ).toHaveCount(1);
  await expect.poll(() => f.source.bundles[0].note_ids).toContain(f.ids[0]);
});
test("a conflicting title draft survives and rebases without overwriting another device's untouched content", async ({
  page,
}) => {
  const f = await setup(page);
  f.delayNext();
  await page.getByLabel("목차 제목").fill("내 입력 유지");
  await expect
    .poll(() => f.calls.filter((c) => c.type === "saveMemoBundle").length)
    .toBe(1);
  Object.assign(f.source.bundles[0], {
    version: 2,
    title: "다른 기기 제목",
    description: "다른 기기가 보완한 본문",
  });
  f.release();
  await expect(
    page.getByRole("button", { name: "최신 원본을 확인하고 내 입력 저장" }),
  ).toBeVisible();
  await expect(page.getByLabel("목차 제목")).toHaveValue("내 입력 유지");
  await page
    .getByRole("button", { name: "최신 원본을 확인하고 내 입력 저장" })
    .click();
  await expect.poll(() => f.source.bundles[0].title).toBe("내 입력 유지");
  expect(f.source.bundles[0].description).toBe("다른 기기가 보완한 본문");
  expect(f.source.bundles[0].version).toBe(3);
});
test("late legacy-only memos remain visible and require explicit merge into the same original", async ({
  page,
}) => {
  const f = await setup(page, "writing", "conflict");
  await expect(
    page.getByRole("region", { name: "이전 상자 메모 확인" }),
  ).toBeVisible();
  expect(f.calls.filter((c) => c.type === "promoteThoughtBoxes")).toHaveLength(
    0,
  );
  await page.getByRole("button", { name: "원본에 추가 메모 합치기" }).click();
  await expect(
    page.getByRole("region", { name: "이전 상자 메모 확인" }),
  ).toHaveCount(0);
  expect(f.source.bundles).toHaveLength(2);
  expect(f.source.bundles[0].note_ids).toEqual(f.ids);
});
for (const width of [390, 1280])
  test(`numbered memo controls stay inside their cards at ${width}px and fullscreen`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 850 });
    await setup(page);
    await page.getByRole("button", { name: "메모 정렬", exact: true }).click();
    await expect(page.locator(".wb-note-order").nth(0)).toHaveValue("3");
    await expect(page.locator(".wb-note-order").nth(1)).toHaveValue("4");
    const layout = await page
      .locator(".wb-note-order")
      .first()
      .evaluate((el) => {
        const r = el.getBoundingClientRect(),
          p = el.closest("article")!.getBoundingClientRect();
        return {
          width: r.width,
          inside: r.left >= p.left && r.right <= p.right,
        };
      });
    expect(layout.inside).toBe(true);
    expect(layout.width).toBeGreaterThan(10);
    await page.getByRole("button", { name: "전체화면", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "이전화면", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".wb-note-order").first()).toBeVisible();
    await page.screenshot({
      path: info.outputPath(`writing-${width}.png`),
      fullPage: false,
    });
  });

test("ordinary board thought selections toggle without saving, and returning to All shows only memos", async ({
  page,
}) => {
  const f = await setup(page, "whiteboard");
  const before = structuredClone(f.boards.get(WHITEBOARD_ID));
  await page.locator(".wb-connection-list summary").click();
  const row = page
    .locator(".wb-connection-select")
    .filter({ hasText: "둘째 생각묶음" });
  await row.click();
  await expect(page.locator(".writing-chapter")).toHaveCount(1);
  await expect(row).toHaveAttribute("aria-pressed", "true");
  await row.click();
  await expect(page.locator(".writing-chapter")).toHaveCount(0);
  await row.click();
  await page
    .getByRole("button", { name: "전체 보드 보기", exact: true })
    .click();
  await expect(page.locator(".writing-chapter")).toHaveCount(0);
  await expect(page.locator(".wb-group")).toHaveCount(0);
  await expect(page.locator(".wb-note")).toHaveCount(2); // ordinary hidden memo stays hidden
  expect(f.boards.get(WHITEBOARD_ID)).toEqual(before);
  expect(
    f.calls.filter(
      (c) => c.type === "saveWhiteboard" || c.type === "saveMemoBundle",
    ),
  ).toHaveLength(0);
});
test("writing display selections can be hidden again without removing project originals", async ({
  page,
}) => {
  const f = await setup(page);
  const original = structuredClone(f.boards.get(f.projectId));
  await page.locator(".wb-connection-list summary").click();
  const row = page
    .locator(".wb-connection-select")
    .filter({ hasText: "둘째 생각묶음" });
  await row.click();
  await expect(page.locator(".writing-chapter")).toHaveCount(2);
  await row.click();
  await expect(page.locator(".writing-chapter")).toHaveCount(1);
  expect(f.boards.get(f.projectId)).toEqual(original);
  expect(f.source.bundles).toHaveLength(2);
});
test("an obsolete saved connection frame disappears after unlink and viewing does not wait for a pending save", async ({
  page,
}) => {
  const f = await setup(page, "whiteboard"),
    extra = { ...f.source.notes[2], id: randomUUID(), title: "메모4" },
    manual = "manual:" + randomUUID();
  f.source.notes.push(extra);
  f.source.connections.push({
    id: randomUUID(),
    source_kind: "note",
    target_kind: "note",
    source_id: f.ids[2],
    target_id: extra.id,
    status: "accepted",
    relation: "related",
    reason: "연결 이유",
    version: 1,
  });
  f.boards.get(WHITEBOARD_ID).data.groups = [
    { id: manual, title: "연결된 메모", noteIds: [f.ids[2], extra.id] },
  ];
  await page.evaluate(() => {
    (window as any).fixture.notes = [...(window as any).fixture.notes];
    (window as any).mount("whiteboard");
  });
  await page.locator(".wb-connection-list summary").click();
  const row = page
    .locator(".wb-connection-select")
    .filter({ hasText: "메모3 ↔ 메모4" });
  await row.click();
  await expect(page.locator(".wb-group")).toHaveCount(1);
  await row.click();
  await expect(page.locator(".wb-group")).toHaveCount(0);
  await row.click();
  await page
    .locator(".wb-connection-list")
    .getByRole("button", { name: "연결 해제", exact: true })
    .click();
  await expect(page.locator(".wb-group")).toHaveCount(0);
  await page
    .getByRole("button", { name: "전체 보드 보기", exact: true })
    .click();
  await expect(page.locator(".wb-group")).toHaveCount(0);
  await expect(page.locator(".wb-note")).toHaveCount(3);
});
test("displaying another box responds while a canonical save is still waiting", async ({
  page,
}) => {
  const f = await setup(page);
  f.delayNext();
  await page.getByLabel("목차 제목").fill("느린 저장 검수");
  await expect
    .poll(() => f.calls.filter((c) => c.type === "saveMemoBundle").length)
    .toBe(1);
  await page.locator(".wb-connection-list summary").click();
  await page
    .locator(".wb-connection-select")
    .filter({ hasText: "둘째 생각묶음" })
    .click();
  await expect(page.locator(".writing-chapter")).toHaveCount(2);
  expect(f.source.bundles[0].version).toBe(1);
  f.release();
  await expect.poll(() => f.source.bundles[0].title).toBe("느린 저장 검수");
});
test("a display-only box on an empty saved board can be removed and moved without losing its original", async ({
  page,
}) => {
  const f = await setup(page, "whiteboard");
  f.boards.get(WHITEBOARD_ID).data = emptyBoard();
  await page.evaluate(() => {
    (window as any).fixture.notes = [...(window as any).fixture.notes];
    (window as any).mount("whiteboard");
  });
  await page.locator(".wb-connection-list summary").click();
  const row = page
    .locator(".wb-connection-select")
    .filter({ hasText: "둘째 생각묶음" });
  await row.click();
  await expect(page.locator(".writing-chapter")).toHaveCount(1);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "상자 삭제", exact: true }).click();
  await expect(page.locator(".writing-chapter")).toHaveCount(0);
  expect(f.source.bundles).toHaveLength(2);
  expect(f.boards.get(WHITEBOARD_ID).data.writing).toBeUndefined();
  await row.click();
  const note = page.locator(".wb-note[data-chapter-note-id]").first();
  const rect = await note.boundingBox();
  if (!rect) throw Error("missing memo");
  const before = await note.getAttribute("style");
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    rect.x + rect.width / 2 + 30,
    rect.y + rect.height / 2 + 30,
    { steps: 5 },
  );
  await page.mouse.up();
  await expect(note).not.toHaveAttribute("style", before!);
  await expect
    .poll(() => f.boards.get(WHITEBOARD_ID).data.writing?.chapters.length)
    .toBe(1);
});
test("a new box is visible after returning to the plain ordinary board", async ({
  page,
}) => {
  const f = await setup(page, "whiteboard");
  await page.locator(".wb-connection-list summary").click();
  await page
    .locator(".wb-connection-select")
    .filter({ hasText: "둘째 생각묶음" })
    .click();
  await page
    .getByRole("button", { name: "전체 보드 보기", exact: true })
    .click();
  await expect(page.locator(".writing-chapter")).toHaveCount(0);
  await page.getByRole("button", { name: "상자 추가", exact: true }).click();
  await expect(page.locator(".writing-chapter")).toHaveCount(1);
  await expect.poll(() => f.source.bundles.length).toBe(3);
});
test("hiding a saved project box only changes display and keeps its text in exports", async ({
  page,
}) => {
  const f = await setup(page);
  await page.locator(".wb-connection-list summary").click();
  const row = page
    .locator(".wb-connection-select")
    .filter({ hasText: "첫 생각묶음" });
  await row.click();
  await row.click();
  await expect(page.locator(".writing-chapter")).toHaveCount(0);
  await page.evaluate(() => {
    const original = URL.createObjectURL;
    URL.createObjectURL = (blob) => {
      (window as any).exported = blob;
      return original(blob);
    };
  });
  await page.getByRole("button", { name: "MD 내보내기", exact: true }).click();
  const text = await page.evaluate(
    async () => await (window as any).exported.text(),
  );
  expect(text).toContain(f.source.notes[0].content);
  expect(text).toContain(f.source.notes[1].content);
  expect(f.boards.get(f.projectId).data.writing.chapters).toHaveLength(1);
});
