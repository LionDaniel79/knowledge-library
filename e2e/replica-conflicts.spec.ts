import { test, expect } from "@playwright/test";
import { build } from "esbuild";
let script: string;
test.beforeAll(async () => {
  const code = `import {createRoot} from 'react-dom/client';import {openReplica} from './src/client/replica/indexed-db';import {resourceFixture} from './tests/helpers/replica-resources';import {queueReplicaCommand} from './src/client/replica/outbox';import {pushReplica} from './src/client/replica/push';import {sha256Bytes} from './src/lib/replica/codec';import {createLibraryRuntime} from './src/client/replica/runtime';import {ReplicaProvider} from './src/components/replica/provider';import {ConflictReviewPanel} from './src/components/replica/conflict-review';(async()=>{const s=await openReplica('resources'),f=await resourceFixture(s);for(const [i,content] of ['기기 첫 초안','기기 마지막 초안'].entries())await queueReplicaCommand({storage:s,repository:f.repo,path:'/api/library',body:{requestId:crypto.randomUUID(),type:'editNote',payload:{id:f.note,expectedVersion:i+1,title:'내 글',content,kind:'thought',bookId:f.book}}});const cp=await s.checkpoint(),value={...await f.repo.raw('library_notes',f.note),content:'서버의 별도 수정',version:2},inline=JSON.stringify(value),bytes=new TextEncoder().encode(inline);await s.stageRows(cp.generation,[{entity:'library_notes',key:JSON.stringify([f.note]),revision:'2',deleted:false,sha256:await sha256Bytes(bytes),inline,bytes:bytes.length}]);await pushReplica({storage:s,send:async()=>{throw Object.assign(Error('다른 기기의 수정'),{status:409})},pull:async()=>{}});f.repo.close();const runtime=createLibraryRuntime('resources',s,await s.checkpoint());window.runtime=runtime;createRoot(document.getElementById('root')).render(<ReplicaProvider runtime={runtime}><ConflictReviewPanel/></ReplicaProvider>);})();`;
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
test("compares all three texts on mobile, retains a closed merge draft and saves a new request without losing prior drafts", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
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
  await page.goto("https://conflict.test/");
  await page.addStyleTag({ path: "src/app/globals.css" });
  await page.getByText("동기화 확인 · 1개", { exact: true }).click();
  await page.getByRole("button", { name: "검토", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "동기화 충돌 확인",
    exact: true,
  });
  await expect(dialog).toContainText("정보와 신뢰");
  await expect(dialog).toContainText("서버의 별도 수정");
  await expect(dialog).toContainText("기기 마지막 초안");
  const box = await dialog.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await dialog
    .getByRole("textbox", { name: "선택할 내용", exact: true })
    .fill("검토해서 합친 생각");
  await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  await page.getByRole("button", { name: "검토", exact: true }).click();
  await expect(
    dialog.getByRole("textbox", { name: "선택할 내용", exact: true }),
  ).toHaveValue("검토해서 합친 생각");
  const downloaded = page.waitForEvent("download");
  await dialog
    .getByRole("button", { name: "입력 원문 내려받기", exact: true })
    .click();
  expect((await downloaded).suggestedFilename()).toContain("원문");
  await dialog
    .getByRole("button", { name: "선택한 글로 저장", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  const data = await page.evaluate(async () => {
    const s = (window as any).runtime.storage;
    return {
      entries: await s.listOutbox(),
      history: await s.listConflicts(true),
    };
  });
  expect(data.entries).toHaveLength(1);
  expect(data.entries[0].command.body.payload).toMatchObject({
    expectedVersion: 2,
    content: "검토해서 합친 생각",
  });
  expect(data.history[0].resolution.entries).toHaveLength(2);
});
