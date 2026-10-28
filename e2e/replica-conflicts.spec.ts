import { test, expect } from "@playwright/test";
import { build } from "esbuild";
let script: string;
test.beforeAll(async () => {
  const code = `
import {createRoot} from 'react-dom/client';
import {openReplica} from './src/client/replica/indexed-db';
import {resourceFixture} from './tests/helpers/replica-resources';
import {queueReplicaCommand} from './src/client/replica/outbox';
import {pushReplica} from './src/client/replica/push';
import {sha256Bytes} from './src/lib/replica/codec';
import {createLibraryRuntime} from './src/client/replica/runtime';
import {ReplicaProvider} from './src/components/replica/provider';
import {ConflictReviewPanel} from './src/components/replica/conflict-review';
import {WHITEBOARD_ID} from './src/lib/whiteboard';
(async()=>{
  const s=await openReplica('resources'),f=await resourceFixture(s);
  const stage=async(entity,value)=>{
    const cp=await s.checkpoint(),inline=JSON.stringify(value),bytes=new TextEncoder().encode(inline);
    await s.stageRows(cp.generation,[{entity,key:JSON.stringify([value.id]),revision:String(value.version),deleted:false,sha256:await sha256Bytes(bytes),inline,bytes:bytes.length}]);
    f.repo.invalidate();
  };
  const queue=(type,payload,path='/api/library')=>queueReplicaCommand({storage:s,repository:f.repo,path,body:{requestId:crypto.randomUUID(),type,payload}});
  const mode=new URL(location.href).searchParams.get('mode');
  if(mode==='archived-topic'){
    const topic={id:crypto.randomUUID(),name:'영성',parent_id:null,aliases:[],description:'',kdc_codes:[],confirmed:true,archived_at:null,version:1};
    await stage('library_topics',topic);
    await queue('assignTopic',{topicId:topic.id,sourceKind:'note',sourceId:f.note,sourceVersion:'1',status:'accepted',expectedVersion:0},'/api/thought-map');
    await stage('library_topics',{...topic,archived_at:'2026-10-28T00:00:00Z',version:2});
  }else if(mode==='new-board'){
    await queue('saveWhiteboard',{expectedVersion:0,data:{schema:1,filter:{topics:[],tags:[],categories:[],books:[],q:''},positions:{},groupPositions:{},groups:[],collapsed:[],links:[]}},'/api/knowledge');
  }else if(mode==='new-topic'){
    await queue('upsertTopic',{name:'새로운 주제',parentId:null,aliases:[],description:'새 주제 내용',kdcCodes:[]},'/api/thought-map');
  }else if(mode?.startsWith('new-note')){
    const created=await queue('addNote',{title:'새 메모',content:'최초 작성한 내용',kind:'thought',bookId:f.book});
    await queue('editNote',{id:created.id,expectedVersion:1,title:'새 메모',content:'마지막으로 고친 내용',kind:'thought',bookId:f.book});
  }else if(mode==='reading'){
    const id=crypto.randomUUID();
    const cycle={id,book_id:f.book,status:'reading',started_on:'2026-09-01',completed_on:null,current_page:125,version:1};
    await stage('library_cycles',cycle);
    await queue('updateProgress',{id,expectedVersion:1,currentPage:305});
    await stage('library_cycles',{...cycle,current_page:465,version:2});
  }else if(mode==='delete'){
    const original=await f.repo.raw('library_notes',f.note);
    await queue('deleteNote',{id:f.note,expectedVersion:1});
    await stage('library_notes',{...original,version:2});
  }else if(mode==='board'){
    const data={schema:1,filter:{topics:[],tags:[],categories:[],books:[],q:''},positions:{['unclassified::'+f.note]:{x:20,y:40}},groupPositions:{},groups:[],collapsed:[],links:[]};
    await stage('library_whiteboards',{id:WHITEBOARD_ID,data,version:1});
    await queue('saveWhiteboard',{expectedVersion:1,data:{...data,positions:{...data.positions,['unclassified::'+crypto.randomUUID()]:{x:250,y:40}}}},'/api/knowledge');
    await stage('library_whiteboards',{id:WHITEBOARD_ID,data:{...data,positions:{...data.positions,['unclassified::'+crypto.randomUUID()]:{x:20,y:250},['unclassified::'+crypto.randomUUID()]:{x:250,y:250}}},version:2});
  }else{
    for(const [i,content] of ['기기 첫 초안','기기 마지막 초안'].entries())await queue('editNote',{id:f.note,expectedVersion:i+1,title:'내 글',content,kind:'thought',bookId:f.book});
    await stage('library_notes',{...await f.repo.raw('library_notes',f.note),content:'서버의 별도 수정',version:2});
  }
  await pushReplica({storage:s,send:async()=>{throw Object.assign(Error('다른 기기의 수정'),{status:409})},pull:async()=>{}});
  if(mode==='new-note-child'){const entries=await s.listOutbox();await s.putOutbox({...entries.at(-1),state:'failed'});}
  f.repo.close();
  const runtime=createLibraryRuntime('resources',s,await s.checkpoint());
  window.runtime=runtime;
  createRoot(document.getElementById('root')).render(<ReplicaProvider runtime={runtime}><ConflictReviewPanel/></ReplicaProvider>);
})();`;
  script = (
    await build({
      stdin: { contents: code, loader: "tsx", resolveDir: process.cwd() },
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      jsx: "automatic",
      define: {
        "process.env.NODE_ENV": '"production"',
        "import.meta.url": '"https://conflict.test/assets/main.js"',
      },
    })
  ).outputFiles[0].text;
});

test("an archived-topic review explicitly offers restoration and queues it before classification", async ({
  page,
}) => {
  await mount(page, "archived-topic");
  const dialog = page.getByRole("dialog", { name: "동기화 내용 선택" });
  await expect(dialog).toContainText("‘영성’ 주제를 복원하고 분류 적용");
  await dialog.getByRole("radio", { name: "PC 내용 선택" }).check();
  await dialog
    .getByRole("button", { name: "주제 복원 후 적용", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".sync-issue-card")).toHaveCount(0);
  const types = await page.evaluate(async () =>
    (await (window as any).runtime.storage.listOutbox()).map(
      (e: any) => e.command.body.type,
    ),
  );
  expect(types).toEqual(["restoreTopic", "assignTopic"]);
});

for (const mode of ["new-note", "new-board", "new-topic"])
  test(`keeping ${mode} removes its review card while preserving original input history`, async ({
    page,
  }) => {
    await mount(page, mode);
    const dialog = page.getByRole("dialog", {
      name: "동기화 내용 선택",
      exact: true,
    });
    await dialog
      .getByRole("radio", { name: "PC 내용 선택", exact: true })
      .check();
    await dialog
      .getByRole("button", { name: "선택한 내용 적용", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator(".sync-issues")).toHaveCount(0);
    await expect(page.locator(".error")).toHaveCount(0);
    const stored = await page.evaluate(async () => ({
      outbox: await (window as any).runtime.storage.listOutbox(),
      history: await (window as any).runtime.storage.listConflicts(true),
    }));
    expect(stored.outbox.length).toBeGreaterThan(0);
    expect(stored.outbox.every((e: any) => e.state === "pending")).toBe(true);
    expect(
      stored.history.some(
        (h: any) => h.resolvedAt && h.resolution.choice === "mine",
      ),
    ).toBe(true);
  });
test("opening a later failed edit keeps the newest draft editable under the first review identity", async ({
  page,
}) => {
  await mount(page, "new-note-child");
  const dialog = page.getByRole("dialog", {
    name: "동기화 내용 선택",
    exact: true,
  });
  await dialog.getByRole("radio", { name: "직접 수정", exact: true }).check();
  const content = dialog.getByRole("textbox", {
    name: "선택할 내용",
    exact: true,
  });
  await expect(content).toHaveValue("마지막으로 고친 내용");
  await content.fill("검토하며 합친 내용");
  await dialog
    .getByRole("button", { name: "선택한 내용 적용", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".sync-issues")).toHaveCount(0);
  const entries = await page.evaluate(async () =>
    (window as any).runtime.storage.listOutbox(),
  );
  expect(entries.at(-1).command.body.payload.content).toBe(
    "검토하며 합친 내용",
  );
});
async function mount(
  page: import("@playwright/test").Page,
  mode = "note",
  width = 390,
) {
  await page.setViewportSize({ width, height: 844 });
  await page.route("https://conflict.test/**", (r) => {
    const path = new URL(r.request().url()).pathname;
    if (path.startsWith("/api/")) return r.abort();
    if (path === "/main.js")
      return r.fulfill({ contentType: "application/javascript", body: script });
    return r.fulfill({
      contentType: "text/html",
      body: '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script>window.Worker=undefined</script><script src="/main.js"></script>',
    });
  });
  await page.goto(`https://conflict.test/?mode=${mode}`);
  await page.addStyleTag({ path: "src/app/globals.css" });
  await page.getByText(/^동기화 확인 · \d+개$/).click();
  const items = page.getByRole("button", { name: /^검토/ });
  await (mode === "new-note-child" ? items.last() : items.first()).click();
}
test("clicking a readable server card only selects it until explicit Apply", async ({
  page,
}) => {
  await mount(page);
  const dialog = page.getByRole("dialog", {
    name: "동기화 내용 선택",
    exact: true,
  });
  await expect(dialog.locator("pre")).toHaveCount(0);
  const apply = dialog.getByRole("button", {
    name: "선택한 내용 적용",
    exact: true,
  });
  await expect(apply).toBeDisabled();
  const before = await page.evaluate(async () =>
    (window as any).runtime.storage.listOutbox(),
  );
  await dialog.getByText("서버의 별도 수정", { exact: true }).click();
  await expect(
    dialog.getByRole("radio", { name: "서버 내용 선택", exact: true }),
  ).toBeChecked();
  const selected = await page.evaluate(async () =>
    (window as any).runtime.storage.listOutbox(),
  );
  expect(selected).toEqual(before);
  await apply.click();
  await expect(dialog).not.toBeVisible();
  const result = await page.evaluate(async () => ({
    entries: await (window as any).runtime.storage.listOutbox(),
    history: await (window as any).runtime.storage.listConflicts(true),
  }));
  expect(result.entries).toHaveLength(0);
  expect(result.history[0].resolution.choice).toBe("server");
  expect(result.history[0].resolution.entries).toHaveLength(2);
});
test("compares all three texts on mobile, retains a closed merge draft and saves a new request without losing prior drafts", async ({
  page,
}) => {
  await mount(page);
  const dialog = page.getByRole("dialog", {
    name: "동기화 내용 선택",
    exact: true,
  });
  await expect(dialog).toContainText("서버의 별도 수정");
  await expect(dialog).toContainText("기기 마지막 초안");
  const box = await dialog.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await dialog.getByRole("radio", { name: "직접 수정", exact: true }).check();
  await dialog
    .getByRole("textbox", { name: "선택할 내용", exact: true })
    .fill("검토해서 합친 생각");
  await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  await page.getByRole("button", { name: /^검토/ }).click();
  await expect(
    dialog.getByRole("textbox", { name: "선택할 내용", exact: true }),
  ).toHaveValue("검토해서 합친 생각");
  await dialog.getByText("원본·상세 보기", { exact: true }).click();
  await expect(dialog).toContainText("정보와 신뢰");
  const downloaded = page.waitForEvent("download");
  await dialog
    .getByRole("button", { name: "입력 원문 내려받기", exact: true })
    .click();
  expect((await downloaded).suggestedFilename()).toContain("원문");
  await dialog
    .getByRole("button", { name: "선택한 내용 적용", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  const data = await page.evaluate(async () => {
    const s = (window as any).runtime.storage;
    return {
      entries: await s.listOutbox(),
      history: await s.listConflicts(true),
    };
  });
  expect(data.entries).toHaveLength(2);
  expect(data.entries[1].command.body.payload).toMatchObject({
    expectedVersion: 3,
    content: "검토해서 합친 생각",
  });
  expect(data.history[0].resolution.entries).toHaveLength(2);
});

test("reading cards display the book and pages, use desktop columns, and support keyboard selection", async ({
  page,
}, info) => {
  await mount(page, "reading", 1280);
  const dialog = page.getByRole("dialog", { name: "동기화 내용 선택" });
  await expect(
    dialog.getByRole("heading", { name: "넥서스", exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText("465쪽", { exact: true })).toBeVisible();
  await expect(dialog.getByText("305쪽", { exact: true })).toBeVisible();
  expect(
    (await dialog.getByText("465쪽", { exact: true }).boundingBox())!.height,
  ).toBeLessThan(50);
  const cards = dialog.locator(".sync-choice-card"),
    a = await cards.nth(0).boundingBox(),
    b = await cards.nth(1).boundingBox();
  expect(Math.abs(a!.y - b!.y)).toBeLessThan(2);
  expect(b!.x).toBeGreaterThan(a!.x + a!.width);
  const radio = dialog.getByRole("radio", {
    name: "PC 내용 선택",
    exact: true,
  });
  await radio.focus();
  await page.keyboard.press("Space");
  await expect(radio).toBeChecked();
  await expect(
    dialog.getByRole("button", { name: "선택한 내용 적용", exact: true }),
  ).toBeEnabled();
  expect(
    await page.evaluate(async () =>
      (window as any).runtime.storage.listOutbox(),
    ),
  ).toHaveLength(1);
  await page.screenshot({ path: info.outputPath("reading-desktop.png") });
});

test("identical memo text still offers a clear keep or trash choice on mobile", async ({
  page,
}, info) => {
  await mount(page, "delete");
  const dialog = page.getByRole("dialog", { name: "동기화 내용 선택" });
  await expect(
    dialog.getByText("현재 기록 유지", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText("휴지통으로 이동", { exact: true }),
  ).toBeVisible();
  await dialog.getByText("휴지통으로 이동", { exact: true }).click();
  await expect(
    dialog.getByRole("radio", { name: "PC 내용 선택", exact: true }),
  ).toBeChecked();
  expect(
    await page.evaluate(async () =>
      (window as any).runtime.storage.listOutbox(),
    ),
  ).toHaveLength(1);
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
  await page.screenshot({ path: info.outputPath("delete-mobile.png") });
});

test("whiteboard shows layout thumbnails and counts while originals stay folded", async ({
  page,
}) => {
  await mount(page, "board");
  const dialog = page.getByRole("dialog", { name: "동기화 내용 선택" });
  await expect(
    dialog.getByRole("img", { name: "온라인 서재 화이트보드 배치 미리보기" }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("img", { name: "이 PC 화이트보드 배치 미리보기" }),
  ).toBeVisible();
  await expect(dialog.getByText("3개", { exact: true })).toBeVisible();
  await expect(dialog.getByText("2개", { exact: true })).toBeVisible();
  await expect(dialog.locator("pre")).toHaveCount(0);
  await dialog.getByText("원본·상세 보기", { exact: true }).click();
  await expect(dialog.locator("pre")).toHaveCount(3);
});
