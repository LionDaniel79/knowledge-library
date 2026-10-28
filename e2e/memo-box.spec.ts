import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { emptyBoard } from "../src/lib/whiteboard";
let bundle: string;
test.beforeAll(async () => {
  bundle = (
    await build({
      stdin: {
        contents: `import {createRoot} from 'react-dom/client';import {useState} from 'react';import {KnowledgePanel} from './src/components/knowledge-panel';import {LibraryForm} from './src/components/library-forms';import {ReplicaProvider} from './src/components/replica/provider';
let snapshot={ready:false,revision:0};const listeners=new Set();const runtime={getSnapshot:()=>snapshot,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},sync:async()=>{}};window.refreshFixture=()=>{snapshot={...snapshot,revision:snapshot.revision+1};listeners.forEach(fn=>fn())};
function Harness(){const[editor,setEditor]=useState(null);return <ReplicaProvider runtime={runtime}><KnowledgePanel library={window.fixture.library} onOpen={(k,id)=>{window.opened={k,id}}} onNewNote={c=>setEditor({kind:'note',...c})}/>{editor&&<LibraryForm editor={editor} library={window.fixture.library} today="2026-10-25" preview={false} onClose={()=>setEditor(null)} onSave={async c=>{window.saved=c;setEditor(null)}}/>}</ReplicaProvider>};createRoot(document.getElementById('root')).render(<Harness/>);`,
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
async function mount(page: Page) {
  const topics = ["공감", "경계"].map((name) => ({
    id: crypto.randomUUID(),
    name,
    description: "생각의 분류",
    aliases: [],
    parentId: null,
    kdcCodes: [],
    confirmed: true,
    version: 1,
  }));
  const notes = ["처음 생각", "지금 생각", "새 결론"].map((title, i) => ({
    id: crypto.randomUUID(),
    title,
    content: `${title}에 관한 나의 문장 ${i}`,
    bookId: null,
    kind: "thought",
    page: null,
    tags: [],
    version: 1,
    createdAt: "2026-10-25T00:00:00Z",
    updatedAt: "2026-10-25T00:00:00Z",
  }));
  const state: any = {
    research: [],
    items: [],
    placements: [],
    connections: [],
  };
  const source: any = {
    board: { id: crypto.randomUUID(), version: 1, data: emptyBoard() },
    notes,
    books: [],
    topics,
    memberships: notes.map((n, i) => ({
      topicId: topics[i === 0 ? 0 : 1].id,
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
        relation: "related",
        reason: "비교",
        status: "accepted",
        version: 1,
      },
    ],
    topicLinks: [],
  };
  const commands: any[] = [];
  await page.route("https://library.test/api/whiteboard", (r) =>
    r.fulfill({ json: source }),
  );
  await page.route("https://library.test/api/note-topics*", (r) =>
    r.fulfill({ json: { topics, memberships: [] } }),
  );
  await page.route("https://library.test/api/books?*", (r) =>
    r.fulfill({ json: { items: [], total: 0 } }),
  );
  await page.route("https://library.test/api/library-materials?*", (r) =>
    r.fulfill({ json: { items: [], total: 0 } }),
  );
  await page.route("https://library.test/api/assist", (r) =>
    r.fulfill({ json: { requests: [], policy: {}, usage: [], workers: [] } }),
  );
  await page.route("https://library.test/api/thought-map", (r) => {
    if (r.request().method() === "POST") {
      const c = r.request().postDataJSON();
      commands.push(c);
      return r.fulfill({ json: { id: c.payload.id } });
    }
    return r.fulfill({
      json: {
        topics,
        memberships: [],
        topicLinks: [],
        notes,
        candidates: [],
        feedback: [],
        archivedTopics: [],
      },
    });
  });
  await page.route("https://library.test/api/knowledge", (r) => {
    if (r.request().method() !== "POST") return r.fulfill({ json: state });
    const c = r.request().postDataJSON(),
      p = c.payload;
    commands.push(c);
    let id = p.id ?? crypto.randomUUID();
    if (c.type === "createResearch")
      state.research.push({ ...p, question: p.question.trim(), id });
    if (c.type === "updateResearch")
      Object.assign(
        state.research.find((x: any) => x.id === p.id),
        p,
      );
    if (c.type === "editConnection")
      Object.assign(
        source.connections.find((x: any) => x.id === p.id),
        p,
        { version: 2 },
      );
    if (c.type === "addResearchNote") {
      const n = notes.find((n) => n.id === p.noteId)!;
      state.items.push({
        id,
        created_at: new Date(
          Date.UTC(2026, 9, 25, 0, 0, state.items.length),
        ).toISOString(),
        research_id: p.researchId,
        snapshot: { note: structuredClone(n), book: null },
      });
    }
    if (c.type === "moveResearchItems")
      for (const i of p.items) {
        let old = state.placements.find((x: any) => x.id === i.itemId);
        if (old)
          Object.assign(old, {
            position: i.position,
            version: old.version + 1,
          });
        else
          state.placements.push({
            id: i.itemId,
            role: "background",
            section: "",
            position: i.position,
            comment: "",
            state: "active",
            version: 1,
          });
      }
    if (c.type === "placeResearchItem") {
      id = p.itemId;
      let old = state.placements.find((x: any) => x.id === p.itemId);
      if (old) Object.assign(old, p, { version: old.version + 1 });
      else state.placements.push({ ...p, id: p.itemId, version: 1 });
    }
    return r.fulfill({
      json: {
        id,
        version:
          c.type === "editConnection"
            ? source.connections.find((x: any) => x.id === id)?.version
            : c.type === "placeResearchItem"
              ? state.placements.find((x: any) => x.id === id)?.version
              : undefined,
      },
    });
  });
  await page.route("https://library.test/", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html lang="ko"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>',
    }),
  );
  await page.goto("https://library.test/");
  await page.evaluate(
    (f) => {
      (window as any).fixture = f;
    },
    { library: { books: [], notes, cycles: [], catalog: { total: 0 } } },
  );
  await page.addStyleTag({ path: "src/app/globals.css" });
  await page.addScriptTag({ content: bundle });
  return { topics, notes, commands, state, source };
}

test("knowledge and memo-box tabs remember the last selection after remount", async ({
  page,
}) => {
  await mount(page);
  await page.getByRole("button", { name: "화이트보드", exact: true }).click();
  await expect(page.locator(".wb-canvas-shell")).toBeVisible();
  await mount(page);
  await expect(page.locator(".wb-canvas-shell")).toBeVisible();
  await page.getByRole("button", { name: "메모 상자", exact: true }).click();
  await page.getByRole("button", { name: "연결된 메모", exact: true }).click();
  await expect(page.locator(".memo-box-list")).toBeVisible();
  await mount(page);
  await expect(page.locator(".memo-box-list")).toBeVisible();
  await expect(
    page.locator(".memo-box .knowledge-tabs button.primary"),
  ).toHaveText("연결된 메모");
});
test("My records is the first memo-box tab and retains its filters and new-note entry without loading connection data", async ({
  page,
}, testInfo) => {
  let boardReads = 0;
  page.on("request", (r) => {
    if (new URL(r.url()).pathname === "/api/whiteboard") boardReads++;
  });
  await mount(page);
  const top = page.locator(".knowledge-panel > .knowledge-tabs");
  await expect(
    top.getByRole("button", { name: "내 기록", exact: true }),
  ).toHaveCount(0);
  const tabs = page.locator(".memo-box > .knowledge-tabs");
  await expect(tabs.getByRole("button")).toHaveText([
    "내 기록",
    "연결된 메모",
    "연결된 주제",
    "글감 엮기",
  ]);
  await expect(
    page.getByRole("combobox", { name: "종류", exact: true }),
  ).toBeVisible();
  expect(boardReads).toBe(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("records-tab.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "연결된 메모", exact: true }).click();
  await expect(page.locator(".memo-box-list > button")).toHaveCount(1);
  await page.getByRole("button", { name: "내 기록", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "종류", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "새 기록", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "새로운 기록" })).toBeVisible();
});

for (const width of [390, 1280])
  test(`connected notes, topic presets and record form fit at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const f = await mount(page);
    for (const name of ["생각의 흐름", "검토할 후보", "사유의 연결"])
      await expect(page.getByRole("button", { name, exact: true })).toHaveCount(
        0,
      );
    await page.getByRole("button", { name: "메모 상자", exact: true }).click();
    await page
      .getByRole("button", { name: "연결된 메모", exact: true })
      .click();
    await expect(page.locator(".memo-box-list > button")).toHaveCount(1);
    await expect(page.locator(".memo-box-list")).toContainText("처음 생각");
    await expect(page.locator(".memo-box-list")).toContainText("지금 생각");
    await expect(page.locator(".memo-box-list")).not.toContainText(
      "에 관한 나의 문장",
    );
    await page.locator(".memo-box-list > button").first().click();
    const detail = page.locator(".memo-box-detail");
    await expect(
      detail.getByRole("heading", { name: "처음 생각", exact: true }),
    ).toBeVisible();
    await detail.getByLabel("연결 이유").fill("경계를 유지하는 공감으로 확장");
    await detail.getByRole("button", { name: "연결 수정 저장" }).click();
    await expect
      .poll(() => f.commands.filter((c) => c.type === "editConnection").length)
      .toBe(1);
    await detail
      .locator(".memo-group-note")
      .first()
      .getByRole("button", { name: "관련 기록 남기기" })
      .click();
    const dialog = page.getByRole("dialog", { name: "새로운 기록" });
    await expect(dialog).toBeVisible();
    await dialog.locator(".note-topic-field summary").click();
    await expect(
      dialog.getByRole("checkbox", { name: "공감", exact: true }),
    ).toBeChecked();
    await dialog.locator('textarea[name="content"]').fill("새롭게 떠오른 생각");
    const gap = await dialog.locator(".book-picker").evaluate((e) => {
      const select = e
          .querySelector('select[name="bookId"]')!
          .getBoundingClientRect(),
        summary = e.querySelector("summary")!.getBoundingClientRect();
      return summary.y - select.bottom;
    });
    expect(gap).toBeLessThanOrEqual(12);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/memo-box/record-${width}.png`,
    });
    await dialog.getByRole("button", { name: "저장하기", exact: true }).click();
    const saved = await page.evaluate(() => (window as any).saved);
    expect(saved.payload.relatedNotes).toEqual([{ noteId: f.notes[0].id }]);
    expect(saved.payload.topicChanges[0]).toMatchObject({
      topicId: f.topics[0].id,
      status: "accepted",
    });
    expect(saved.payload.title).toBe("");
  });
test("topic pairs edit details and create a new thought classified into both topics", async ({
  page,
}) => {
  const f = await mount(page);
  await page.getByRole("button", { name: "메모 상자", exact: true }).click();
  await page.getByRole("button", { name: "연결된 주제", exact: true }).click();
  await page.getByRole("button", { name: "공감 수정", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "주제 수정" });
  await dialog.getByLabel("주제 설명").fill("공감의 의미를 계속 검토");
  await dialog.getByRole("button", { name: "주제 저장", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(
    f.commands.find((c) => c.type === "upsertTopic").payload,
  ).toMatchObject({
    id: f.topics[0].id,
    expectedVersion: 1,
    description: "공감의 의미를 계속 검토",
  });
  await page.getByRole("button", { name: "두 주제에 기록 남기기" }).click();
  await page.locator(".note-topic-field summary").click();
  await expect(
    page.getByRole("checkbox", { name: "공감", exact: true }),
  ).toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "경계", exact: true }),
  ).toBeChecked();
});
test("outline, ordered sources and text export work without changing the original notes", async ({
  page,
}) => {
  const f = await mount(page);
  await page.getByRole("button", { name: "메모 상자", exact: true }).click();
  await page.getByRole("button", { name: "글감 엮기", exact: true }).click();
  await expect(page.getByLabel("제목", { exact: true })).toBeVisible();
  await expect(
    page.getByText("새 글감 묶음 만들기", { exact: true }),
  ).toHaveCount(0);
  await page.getByLabel("제목", { exact: true }).fill("공감에 관한 글");
  await page.getByLabel("목차 · 한 줄에 한 항목").fill("첫 생각\n새 결론");
  await page
    .getByRole("button", { name: "글감 묶음 만들기", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "글감 묶음", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".writing-workbench ol li")).toHaveText([
    "첫 생각",
    "새 결론",
  ]);
  for (const n of f.notes.slice(0, 2)) {
    await page
      .getByRole("combobox", { name: "담을 메모", exact: true })
      .selectOption(n.id);
    await page.getByRole("button", { name: "출처와 함께 담기" }).click();
    await expect(page.locator(".research-board article")).toHaveCount(
      f.notes.indexOf(n) + 1,
    );
  }
  const firstCard = page.locator(".research-board article").filter({
    has: page.getByRole("heading", { name: "처음 생각", exact: true }),
  });
  await firstCard.getByText("역할·순서·내 해석 수정", { exact: true }).click();
  await firstCard
    .getByRole("combobox", { name: "자료 역할", exact: true })
    .selectOption("claim");
  await firstCard
    .getByRole("combobox", { name: "장·절 또는 묶음 제목", exact: true })
    .fill("첫 생각");
  await firstCard
    .getByRole("textbox", { name: "이 자료에 대한 나의 해석", exact: true })
    .fill("아직 저장하지 않은 해석");
  await page
    .getByRole("button", { name: "지금 생각 위로", exact: true })
    .click();
  await expect(page.locator(".research-board article h3").first()).toHaveText(
    "지금 생각",
  );
  await expect(
    firstCard.getByRole("textbox", {
      name: "이 자료에 대한 나의 해석",
      exact: true,
    }),
  ).toHaveValue("아직 저장하지 않은 해석");
  await firstCard
    .getByRole("button", { name: "배치·해석 저장", exact: true })
    .click();
  await expect
    .poll(() => f.commands.filter((c) => c.type === "placeResearchItem").length)
    .toBe(1);
  expect(
    f.commands.find((c) => c.type === "placeResearchItem").payload,
  ).toMatchObject({
    expectedVersion: 1,
    role: "claim",
    section: "첫 생각",
    comment: "아직 저장하지 않은 해석",
    position: 2,
  });
  await page
    .getByRole("button", { name: "제목·목차 수정", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "제목·목차 수정" });
  await dialog.getByLabel("제목", { exact: true }).fill("공감과 경계");
  await page.evaluate(() => (window as any).refreshFixture());
  await expect(dialog.getByLabel("제목", { exact: true })).toHaveValue(
    "공감과 경계",
  );
  await dialog.getByRole("button", { name: "제목·목차 저장" }).click();
  await expect(dialog).toHaveCount(0);
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "글감 내려받기 (.txt)", exact: true })
    .click();
  const file = await download;
  const text = await readFile((await file.path())!, "utf8");
  expect(text).toContain("공감과 경계");
  expect(text).toContain("출처: 나의 생각");
  expect(text).toContain("나의 해석: 아직 저장하지 않은 해석");
  expect(text).toContain("첫 생각 · 주장");
  expect(text.indexOf("지금 생각에 관한")).toBeLessThan(
    text.indexOf("처음 생각에 관한"),
  );
  expect(f.notes[0].content).toBe("처음 생각에 관한 나의 문장 0");
  // Removing a source only changes its placement; its frozen text stays restorable.
  await firstCard
    .getByRole("combobox", { name: "자료 상태", exact: true })
    .selectOption("removed");
  await firstCard
    .getByRole("button", { name: "배치·해석 저장", exact: true })
    .click();
  await expect(firstCard).toHaveCount(0);
  const removedDownload = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "글감 내려받기 (.txt)", exact: true })
    .click();
  expect(
    await readFile((await (await removedDownload).path())!, "utf8"),
  ).not.toContain("처음 생각에 관한");
  await page.getByLabel("묶음에서 뺀 자료도 보기").check();
  await expect(firstCard).toBeVisible();
  await firstCard.getByText("역할·순서·내 해석 수정", { exact: true }).click();
  await firstCard
    .getByRole("combobox", { name: "자료 상태", exact: true })
    .selectOption("active");
  await firstCard
    .getByRole("button", { name: "배치·해석 저장", exact: true })
    .click();
  await expect
    .poll(
      () =>
        f.state.placements.find((p: any) => p.id === f.state.items[0].id)
          ?.state,
    )
    .toBe("active");
  await page.getByLabel("묶음에서 뺀 자료도 보기").uncheck();
  await expect(page.locator(".research-board article")).toHaveCount(2);
  expect(f.notes[0].content).toBe("처음 생각에 관한 나의 문장 0");
});
test("has one writing entry and distinguishes body-only notes by their contents", async ({
  page,
}) => {
  const f = await mount(page);
  f.notes[0].title = "미분류 메모";
  f.notes[0].content = "공감에는 상대방과 나의 경계가 필요하다";
  await expect(
    page.getByRole("button", { name: "설교·논문 자료", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "메모 상자", exact: true }).click();
  await page.getByRole("button", { name: "글감 엮기", exact: true }).click();
  await page.getByLabel("제목", { exact: true }).fill("경계를 생각하는 글");
  await page
    .getByRole("button", { name: "글감 묶음 만들기", exact: true })
    .click();
  const picker = page.getByRole("combobox", { name: "담을 메모", exact: true });
  await expect(
    picker.locator(`option[value="${f.notes[0].id}"]`),
  ).toContainText(f.notes[0].content);
  await picker.selectOption(f.notes[0].id);
  await page.getByRole("button", { name: "출처와 함께 담기" }).click();
  await expect(page.locator(".research-board article h3")).toHaveText(
    f.notes[0].content,
  );
  expect(f.notes[0].title).toBe("미분류 메모");
});

test("a topic edit keeps the original version when newer metadata arrives while typing", async ({
  page,
}) => {
  const code = (
    await build({
      stdin: {
        contents: `import {createRoot} from 'react-dom/client';import {useState} from 'react';import {TopicEditor} from './src/components/memo-box/topic-editor';function App(){const[t,setT]=useState({id:'00000000-0000-4000-8000-000000000012',name:'공감',description:'처음 설명',version:1,aliases:[],kdcCodes:[],parentId:null,confirmed:true});window.refreshTopic=()=>setT({...t,version:2,description:'다른 곳의 설명'});return <TopicEditor topic={t} topics={[t]} busy={false} error='' onClose={()=>{}} onSave={async p=>{window.topicSaved=p}}/>}createRoot(document.getElementById('root')).render(<App/>);`,
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
  await page.route("https://library.test/", (r) =>
    r.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
  );
  await page.goto("https://library.test/");
  await page.addScriptTag({ content: code });
  await page
    .getByRole("textbox", { name: "주제 설명", exact: true })
    .fill("내 설명 초안");
  await page.evaluate(() => (window as any).refreshTopic());
  await page.getByRole("button", { name: "주제 저장", exact: true }).click();
  const saved = await page.evaluate(() => (window as any).topicSaved);
  expect(saved.expectedVersion).toBe(1);
  expect(saved.description).toBe("내 설명 초안");
});
test("refresh keeps an unfinished connection reason and its original version", async ({
  page,
}) => {
  const f = await mount(page);
  await page.getByRole("button", { name: "메모 상자", exact: true }).click();
  await page.getByRole("button", { name: "연결된 메모", exact: true }).click();
  await page.locator(".memo-box-list > button").first().click();
  const detail = page.locator(".memo-box-detail");
  await detail.getByLabel("연결 이유").fill("연결에 관한 내 초안");
  f.source.connections[0].version = 2;
  f.source.connections[0].reason = "다른 곳의 연결 이유";
  f.source.notes[1].title = "갱신된 도착 메모";
  await page.evaluate(() => (window as any).refreshFixture());
  await expect(
    detail.getByRole("heading", { name: "갱신된 도착 메모", exact: true }),
  ).toBeVisible();
  await expect(detail.getByLabel("연결 이유")).toHaveValue(
    "연결에 관한 내 초안",
  );
  await detail.getByRole("button", { name: "연결 수정 저장" }).click();
  await expect
    .poll(() => f.commands.filter((c) => c.type === "editConnection").length)
    .toBe(1);
  expect(
    f.commands.find((c) => c.type === "editConnection").payload.expectedVersion,
  ).toBe(1);
});
