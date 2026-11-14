import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { previewLibrary } from "../src/lib/preview-data";
const ids = [
  "10000000-0000-4000-8000-000000000001",
  "10000000-0000-4000-8000-000000000002",
  "10000000-0000-4000-8000-000000000003",
];
const notes = ids.map((id, i) => ({
  ...previewLibrary.notes[0],
  id,
  title: `메모 ${i + 1}`,
  content: `본문 ${i + 1} 고유 내용`,
  version: 1,
  summary: false,
}));
const connections = [
  [0, 1],
  [1, 2],
].map(([a, b], i) => ({
  id: `20000000-0000-4000-8000-00000000000${i + 1}`,
  source_kind: "note",
  target_kind: "note",
  source_id: ids[a],
  target_id: ids[b],
  title: `개별 연결 ${i + 1}`,
  reason: `개별 이유 ${i + 1}`,
  status: "accepted",
  relation: "related",
  method: "manual",
  version: 1,
}));
const boxId = "30000000-0000-4000-8000-000000000001";
let bundle: string;
test.beforeAll(async () => {
  bundle = (
    await build({
      stdin: {
        contents: `import{createRoot}from'react-dom/client';import{LibraryForm}from'./src/components/library-forms';import{MemoGroupEditor}from'./src/components/memo-box/group-editor';import{ThoughtBoxes}from'./src/components/memo-box/thought-boxes';import{AssistLauncher}from'./src/components/assist-panel';import{connectedMemoGroups}from'./src/lib/memo-box';const f=window.fixture, library={books:[],notes:f.notes,cycles:[]};createRoot(document.getElementById('root')).render(window.mode==='note'?<LibraryForm editor={{kind:'note',note:f.notes[0]}} library={library} today='2026-11-14' preview={false} onClose={()=>{}} onSave={async c=>{window.saved=c}}/>:window.mode==='thought'?<ThoughtBoxes library={library} onOpen={()=>{}}/>:window.mode==='records'?<AssistLauncher library={library}/>:<MemoGroupEditor group={connectedMemoGroups(f)[0]} library={library} boardVersion={0} busy={false} onUpdated={()=>{}} onCommit={async p=>{window.saved=p;return {ok:true}}}/>);`,
        resolveDir: process.cwd(),
        loader: "tsx",
      },
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      logLevel: "silent",
    })
  ).outputFiles[0].text;
});
async function mount(page: Page, mode: string, count = 3) {
  const fixture = {
    notes: notes.slice(0, count),
    connections: connections.slice(0, count - 1),
    books: [],
    topics: [],
    memberships: [],
    board: null,
    bundles: [
      {
        id: boxId,
        title: "생각 원본",
        description: "원래 설명",
        note_ids: ids,
        version: 1,
      },
    ],
  };
  const context = {
    kind:
      mode === "note" ? "note" : mode === "thought" ? "bundle" : "connection",
    id:
      mode === "note"
        ? ids[0]
        : mode === "thought"
          ? boxId
          : fixture.connections
              .map((c) => c.id)
              .sort()
              .join(","),
    noteIds: mode === "note" ? [ids[0]] : fixture.notes.map((n) => n.id),
  };
  const request = {
    id: "40000000-0000-4000-8000-000000000001",
    purpose: "synthesis",
    status: "completed",
    created_at: "2026-11-14T00:00:00Z",
    updated_at: "2026-11-14T00:00:00Z",
    scope: {
      editorContext: context,
      sources: fixture.notes.map((n) => ({
        id: n.id,
        kind: "note",
        version: "1",
      })),
    },
    result: {
      valid: true,
      output: {
        suggestions: [
          {
            kind: "editor_title",
            title: "추천한 새 제목",
            reason: "추천한 연결 이유와 설명",
            sourceIndices: [0],
            outline: [],
            topicIds: [],
            evidence: [],
          },
        ],
      },
    },
  };
  const calls: any[] = [];
  await page.route("https://library.test/**", (r) => {
    const url = new URL(r.request().url());
    if (url.pathname === "/")
      return r.fulfill({
        contentType: "text/html",
        body: '<html lang="ko"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>',
      });
    if (url.pathname === "/api/whiteboard") return r.fulfill({ json: fixture });
    if (url.pathname === "/api/thought-boxes")
      return r.fulfill({
        json: {
          items: [{ id: boxId, title: "생각 원본", noteCount: 3 }],
          pendingLegacy: false,
        },
      });
    if (url.pathname === "/api/assist") {
      if (r.request().method() === "POST") {
        const body = r.request().postDataJSON();
        calls.push(body);
        return r.fulfill({
          json: {
            task: { payload: body.payload },
            estimate: { maxCostUsd: "0.001" },
            policy: { version: 1, requestsEnabled: true, requestLimitUsd: "1" },
            scopeHash: "a".repeat(64),
          },
        });
      }
      return r.fulfill({
        json: { requests: mode === "records" ? [] : [request] },
      });
    }
    return r.fulfill({ json: { items: [], requests: [], candidates: [] } });
  });
  await page.goto("https://library.test/");
  await page.evaluate(
    ({ fixture, mode }) => {
      (window as any).fixture = fixture;
      (window as any).mode = mode;
    },
    { fixture, mode },
  );
  await page.addStyleTag({ path: "src/app/globals.css" });
  await page.addScriptTag({ content: bundle });
  return calls;
}
async function applyTitle(page: Page, label: string) {
  await page.locator(".assist-launcher-summary > span").first().click();
  await page.getByText("내가 요청한 도움", { exact: true }).click();
  await page.locator(".assist-request-row > details > summary").click();
  await page.getByRole("button", { name: label, exact: true }).click();
}
for (const width of [390, 1280])
  test(`group editor has one footer and distinct overall/pair fields (${width}px)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await mount(page, "group");
    await expect(page.locator(".memo-group-note")).toHaveCount(3);
    await expect(page.locator(".memo-aggregate-fields")).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: "수정 저장", exact: true }),
    ).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: "연결 끊기", exact: true }),
    ).toHaveCount(1);
    await expect(page.getByText("메모 수정·분류", { exact: true })).toHaveCount(
      0,
    );
    await expect(
      page.getByText("관련 기록 남기기", { exact: true }),
    ).toHaveCount(0);
    await expect(page.locator(".memo-connection-members").first()).toHaveText(
      "메모 1 ↔ 메모 2",
    );
    await applyTitle(page, "제목과 연결 이유 채우기");
    await expect(
      page.getByLabel("전체 연결 제목", { exact: true }),
    ).toHaveValue("추천한 새 제목");
    await expect(
      page.getByRole("textbox", { name: "전체 연결 이유", exact: true }),
    ).toHaveValue("추천한 연결 이유와 설명");
    await page.getByRole("button", { name: "수정 저장", exact: true }).click();
    expect(await page.evaluate(() => (window as any).saved.title)).toBe(
      "추천한 새 제목",
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
  });
test("a two-note connection shows one editable relationship only", async ({
  page,
}) => {
  await mount(page, "group", 2);
  await expect(page.locator(".memo-group-note")).toHaveCount(2);
  await expect(page.locator(".memo-aggregate-fields")).toHaveCount(0);
  await expect(page.getByLabel("연결 제목", { exact: true })).toHaveCount(1);
});
test("single-note title preview sends one source and applies only the title input", async ({
  page,
}) => {
  const calls = await mount(page, "note", 1);
  await applyTitle(page, "메모 제목으로 사용");
  await expect(
    page.getByRole("textbox", { name: "제목", exact: true }),
  ).toHaveValue("추천한 새 제목");
  await page.getByRole("button", { name: "분석", exact: true }).click();
  await expect.poll(() => calls.length).toBe(1);
  expect(calls[0].payload.sources).toHaveLength(1);
  expect(calls[0].payload.editorContext.kind).toBe("note");
  const labels = await page
    .getByRole("combobox", { name: "도움 방향" })
    .locator("option")
    .allTextContents();
  expect(labels).toContain("메모 제목 추천");
  expect(labels.join(" ")).not.toContain("생각묶음");
});
test("thought box title recommendation fills both existing fields", async ({
  page,
}) => {
  await mount(page, "thought");
  await page.locator(".thought-box-list button").click();
  await applyTitle(page, "제목과 내용 채우기");
  await expect(page.getByLabel("생각묶음 제목", { exact: true })).toHaveValue(
    "추천한 새 제목",
  );
  await expect(page.locator(".thought-box-editor textarea")).toHaveValue(
    "추천한 연결 이유와 설명",
  );
  await expect(
    page.getByRole("combobox", { name: "도움 방향" }).locator("option"),
  ).toHaveCount(1);
});
test("record list omits all three removed menu items", async ({ page }) => {
  await mount(page, "records");
  await page.locator(".assist-launcher-summary > span").first().click();
  await expect(page.getByRole("combobox", { name: "도움 방향" })).toBeVisible();
  expect(
    await page
      .getByRole("combobox", { name: "도움 방향" })
      .locator("option")
      .allTextContents(),
  ).toEqual(["종합검토", "메모 연결 제안"]);
});
