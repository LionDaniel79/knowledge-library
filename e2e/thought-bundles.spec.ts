import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { emptyBoard, WHITEBOARD_ID } from "../src/lib/whiteboard";
let script: string, css: string;
let boardScript: string;
test.beforeAll(async () => {
  script = (
    await build({
      stdin: {
        contents: `import{createRoot}from'react-dom/client';import{BundleWorkspace}from'./src/components/memo-box/bundle-workspace';const root=createRoot(document.getElementById('root'));window.render=()=>root.render(<BundleWorkspace source={structuredClone(window.source)} mode={window.mode} onSaved={window.render} onOpen={(k,id)=>{window.opened=id}}/>);window.render();`,
        resolveDir: process.cwd(),
        loader: "tsx",
      },
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
    })
  ).outputFiles[0].text;
  css = await readFile("src/app/globals.css", "utf8");
  boardScript = (
    await build({
      stdin: {
        contents: `import{createRoot}from'react-dom/client';import{WhiteboardPanel}from'./src/components/whiteboard/panel';createRoot(document.getElementById('root')).render(<WhiteboardPanel library={{notes:window.source.notes,books:[],cycles:[],revisions:[]}} ownerId='test' onOpen={()=>{}}/>);`,
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
test("converts a legacy group without losing its editor or position and connects named bundles independently", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const a = crypto.randomUUID(),
    b = crypto.randomUUID(),
    legacy = "manual:" + crypto.randomUUID(),
    existing = crypto.randomUUID();
  const legacyB = "manual:" + existing;
  const board = emptyBoard();
  board.groups = [
    { id: legacy, title: "기존 묶음", noteIds: [a] },
    { id: legacyB, title: "둘째 기존 묶음", noteIds: [b] },
  ];
  board.links = [{ source: legacy, target: legacyB }];
  board.collapsed = [legacy];
  board.groupPositions[legacy] = { x: 40, y: 50 };
  board.positions[legacy + "::" + a] = { x: 56, y: 104 };
  const source: any = {
    board: { id: WHITEBOARD_ID, data: board, version: 1 },
    notes: [
      { id: a, title: "메모 A", content: "원문 A", tags: [] },
      { id: b, title: "메모 B", content: "원문 B", tags: [] },
    ],
    books: [],
    topics: [],
    memberships: [],
    topicLinks: [],
    connections: [
      {
        id: crypto.randomUUID(),
        source_kind: "note",
        target_kind: "note",
        source_id: a,
        target_id: b,
        status: "accepted",
        relation: "related",
        reason: "원래 연결",
        version: 1,
      },
    ],
    bundles: [],
    bundleLinks: [],
  };
  await page.route("**/*", async (route) => {
    if (route.request().url().includes("/api/whiteboard")) {
      await new Promise((r) => setTimeout(r, 250));
      return route.fulfill({ json: source });
    }
    if (route.request().url().endsWith("/api/knowledge")) {
      const { type, payload: p } = route.request().postDataJSON();
      let result: any;
      if (type === "saveWhiteboard") {
        source.board = {
          ...source.board,
          data: p.data,
          version: source.board.version + 1,
        };
        result = source.board;
      }
      if (type === "saveMemoBundle") {
        let row = source.bundles.find((x: any) => x.id === p.id);
        if (row)
          Object.assign(row, {
            title: p.title,
            description: p.description,
            note_ids: p.noteIds,
            version: row.version + 1,
          });
        else {
          row = {
            id: crypto.randomUUID(),
            title: p.title,
            description: p.description,
            note_ids: p.noteIds,
            version: 1,
            archived_at: null,
          };
          source.bundles.push(row);
        }
        result = row;
      }
      if (type === "saveBundleLink") {
        let row = source.bundleLinks.find((x: any) => x.id === p.id);
        if (row)
          Object.assign(row, {
            relation: p.relation,
            reason: p.reason,
            status: p.status,
            version: row.version + 1,
          });
        else {
          const [left, right] = [p.sourceId, p.targetId].sort();
          row = {
            id: crypto.randomUUID(),
            source_id: left,
            target_id: right,
            relation: p.relation,
            reason: p.reason,
            status: p.status,
            version: 1,
          };
          source.bundleLinks.push(row);
        }
        result = row;
      }
      return route.fulfill({
        json: { id: result.id, version: result.version },
      });
    }
    return route.fulfill({
      contentType: "text/html",
      body: "<html><body><div id='root'></div></body></html>",
    });
  });
  await page.goto("http://127.0.0.1:3000/board-test");
  await page.addStyleTag({ content: css });
  await page.evaluate((s) => {
    (window as any).source = s;
  }, source);
  await page.addScriptTag({ content: boardScript });
  await page
    .getByRole("button", { name: "기존 묶음 묶음 선택", exact: true })
    .click();
  await page
    .getByRole("button", { name: "생각 묶음으로 저장", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "생각 묶음", exact: true });
  await dialog.getByLabel("생각 묶음 이름", { exact: true }).fill("첫 생각");
  await dialog
    .getByRole("button", { name: "생각 묶음 저장", exact: true })
    .click();
  await expect(
    dialog.getByLabel("생각 묶음 이름", { exact: true }),
  ).toHaveValue("첫 생각");
  await expect.poll(() => source.board.data.groups.length).toBe(1);
  const converted = source.bundles.find((g: any) => g.title === "첫 생각");
  expect(source.board.data.groupPositions["bundle:" + converted.id]).toEqual({
    x: 40,
    y: 50,
  });
  await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  expect(source.board.data.collapsed).toContain("bundle:" + converted.id);
  await page
    .getByRole("button", { name: "둘째 기존 묶음 묶음 선택", exact: true })
    .click();
  await page
    .getByRole("button", { name: "생각 묶음으로 저장", exact: true })
    .click();
  await dialog.getByLabel("생각 묶음 이름", { exact: true }).fill("둘째 생각");
  await dialog
    .getByRole("button", { name: "생각 묶음 저장", exact: true })
    .click();
  await expect.poll(() => source.bundleLinks.length).toBe(1);
  await expect.poll(() => source.board.data.groups.length).toBe(0);
  await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  await page
    .getByRole("button", { name: "첫 생각 묶음 선택", exact: true })
    .click();
  await page
    .getByRole("button", { name: "선택한 묶음 연결", exact: true })
    .click();
  await page
    .getByRole("button", { name: "둘째 생각 묶음 선택", exact: true })
    .click();
  const editor = page.getByRole("dialog", { name: "묶음 연결", exact: true });
  await expect(
    editor.getByLabel("출발 생각 묶음", { exact: true }),
  ).not.toHaveValue("");
  await editor
    .getByLabel("묶음 연결 이유", { exact: true })
    .fill("함께 글을 쓰기 위한 연결");
  await editor
    .getByRole("button", { name: "묶음 연결 저장", exact: true })
    .click();
  await expect
    .poll(() => source.bundleLinks[0]?.reason)
    .toBe("함께 글을 쓰기 위한 연결");
  await editor.getByRole("button", { name: "닫기", exact: true }).click();
  await page.locator(".wb-connection-list > summary").click();
  await page
    .getByRole("button", { name: "묶음 연결 해제", exact: true })
    .click();
  await expect.poll(() => source.bundleLinks[0].status).toBe("rejected");
  expect(source.connections).toHaveLength(1);
  expect(source.connections[0].status).toBe("accepted");
  await page.getByRole("button", { name: "되돌리기", exact: true }).click();
  await expect.poll(() => source.bundleLinks[0].status).toBe("accepted");
});
for (const width of [390, 1280])
  test(`keeps overlapping bundles and edits/unlinks only their relationship at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const noteId = crypto.randomUUID();
    const source: any = {
      notes: [{ id: noteId, title: "공유 메모", content: "원래 내용" }],
      books: [],
      topics: [],
      memberships: [],
      connections: [],
      bundles: [],
      bundleLinks: [],
    };
    await page.route("**/*", async (route) => {
      if (route.request().url().endsWith("/api/knowledge")) {
        const { type, payload: p } = route.request().postDataJSON();
        let row: any;
        if (type === "saveMemoBundle") {
          row = source.bundles.find((b: any) => b.id === p.id);
          if (row)
            Object.assign(row, {
              title: p.title,
              description: p.description,
              note_ids: p.noteIds,
              version: row.version + 1,
            });
          else {
            row = {
              id: crypto.randomUUID(),
              title: p.title,
              description: p.description,
              note_ids: p.noteIds,
              version: 1,
              archived_at: null,
            };
            source.bundles.push(row);
          }
        } else if (type === "saveBundleLink") {
          row = source.bundleLinks.find((b: any) => b.id === p.id);
          if (row)
            Object.assign(row, {
              relation: p.relation,
              reason: p.reason,
              status: p.status,
              version: row.version + 1,
            });
          else {
            row = {
              id: crypto.randomUUID(),
              source_id: p.sourceId,
              target_id: p.targetId,
              relation: p.relation,
              reason: p.reason,
              status: p.status,
              version: 1,
            };
            source.bundleLinks.push(row);
          }
        }
        await page.evaluate((s) => {
          (window as any).source = s;
        }, source);
        return route.fulfill({ json: { id: row.id, version: row.version } });
      }
      return route.fulfill({
        contentType: "text/html",
        body: "<html><body><div id='root'></div></body></html>",
      });
    });
    await page.goto("http://127.0.0.1:3000/bundle-test");
    await page.addStyleTag({ content: css });
    await page.evaluate((s) => {
      (window as any).source = s;
      (window as any).mode = "bundles";
    }, source);
    await page.addScriptTag({ content: script });
    for (const title of ["조직의 문제", "교회 회복"]) {
      await page
        .getByRole("button", { name: "새 생각 묶음", exact: true })
        .click();
      await page.getByLabel("생각 묶음 이름", { exact: true }).fill(title);
      await page.getByLabel("공유 메모 선택", { exact: true }).check();
      await page
        .getByRole("button", { name: "생각 묶음 저장", exact: true })
        .click();
      await expect
        .poll(() => source.bundles.length)
        .toBe(title === "조직의 문제" ? 1 : 2);
    }
    expect(source.bundles.every((b: any) => b.note_ids.includes(noteId))).toBe(
      true,
    );
    await page.evaluate(() => {
      (window as any).mode = "links";
      (window as any).render();
    });
    await page
      .getByLabel("출발 생각 묶음", { exact: true })
      .selectOption(source.bundles[0].id);
    await page
      .getByLabel("도착 생각 묶음", { exact: true })
      .selectOption(source.bundles[1].id);
    await page.getByLabel("묶음 관계", { exact: true }).selectOption("applies");
    await page
      .getByLabel("묶음 연결 이유", { exact: true })
      .fill("조직의 문제를 교회 회복에 적용한다");
    await page
      .getByRole("button", { name: "묶음 연결 저장", exact: true })
      .click();
    await expect(
      page.getByRole("button", {
        name: "조직의 문제 ↔ 교회 회복",
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "묶음 연결 끊기", exact: true })
      .click();
    await expect.poll(() => source.bundleLinks[0].status).toBe("rejected");
    expect(source.notes).toHaveLength(1);
    expect(source.bundles).toHaveLength(2);
    expect(source.connections).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
