import { test, expect } from "@playwright/test";
import { build } from "esbuild";
let bundle: string;
test.beforeAll(async () => {
  bundle = (
    await build({
      stdin: {
        contents: `import{createRoot}from'react-dom/client';import{useState}from'react';import{openReplica}from'./src/client/replica/indexed-db';import{resourceFixture}from'./tests/helpers/replica-resources';import{createLibraryRuntime}from'./src/client/replica/runtime';import{ReplicaProvider}from'./src/components/replica/provider';import{LibraryForm}from'./src/components/library-forms';(async()=>{const s=await openReplica('resources');let note=JSON.parse(localStorage.getItem('fixture-note')||'null');if(!note){const f=await resourceFixture(s);note={id:f.note,title:'검수 메모',content:'정보와 신뢰를 함께 생각한다',kind:'thought',bookId:null,page:null,tags:[],version:1,createdAt:'2026-10-27',updatedAt:'2026-10-27'};localStorage.setItem('fixture-note',JSON.stringify(note));f.repo.close();}const runtime=createLibraryRuntime('resources',s,await s.checkpoint());window.runtime=runtime;function App(){const[open,setOpen]=useState(true);return <ReplicaProvider runtime={runtime}><button onClick={()=>setOpen(true)}>메모 열기</button>{open&&<LibraryForm editor={{kind:'note',note}} library={{books:[],notes:[note],cycles:[]}} today="2026-10-27" preview={false} onClose={()=>setOpen(false)} onSave={async()=>{throw Error('메모 본문은 저장하지 않는 검사')}}/>}</ReplicaProvider>}createRoot(document.getElementById('root')).render(<App/>);})();`,
        resolveDir: process.cwd(),
        loader: "tsx",
      },
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      jsx: "automatic",
      define: {
        "process.env.NODE_ENV": '"production"',
        "import.meta.url": '"https://visibility.test/main.js"',
      },
    })
  ).outputFiles[0].text;
});
test("all shared note editors can hide and show offline without saving or losing the note, including after reload", async ({
  page,
}) => {
  await page.route("https://visibility.test/**", (r) => {
    const p = new URL(r.request().url()).pathname;
    if (p.startsWith("/api/")) return r.abort();
    if (p === "/main.js")
      return r.fulfill({ contentType: "application/javascript", body: bundle });
    return r.fulfill({
      contentType: "text/html",
      body: '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script>window.Worker=undefined</script><script src="/main.js"></script>',
    });
  });
  await page.goto("https://visibility.test/");
  await page.addStyleTag({ path: "src/app/globals.css" });
  const dialog = page.getByRole("dialog", { name: "기록 수정" }),
    setting = dialog.getByRole("group", { name: "화이트보드 표시" });
  await expect(
    setting.getByRole("button", { name: "보이기", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await setting.getByRole("button", { name: "가리기", exact: true }).click();
  await expect(
    setting.getByRole("button", { name: "가리기", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const s = (window as any).runtime.storage;
        return (await s.listOutbox()).length;
      }),
    )
    .toBe(1);
  await expect(dialog.locator('textarea[name="content"]')).toHaveValue(
    "정보와 신뢰를 함께 생각한다",
  );
  await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  await page.reload();
  await page.addStyleTag({ path: "src/app/globals.css" });
  await expect(
    setting.getByRole("button", { name: "가리기", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await setting.getByRole("button", { name: "보이기", exact: true }).click();
  await expect(
    setting.getByRole("button", { name: "보이기", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(() =>
      page.evaluate(
        async () => (await (window as any).runtime.storage.listOutbox()).length,
      ),
    )
    .toBe(2);
  const commands = await page.evaluate(async () =>
    (await (window as any).runtime.storage.listOutbox()).map(
      (e: any) => e.command.body,
    ),
  );
  expect(commands.map((c: any) => c.type)).toEqual([
    "setWhiteboardNoteVisibility",
    "setWhiteboardNoteVisibility",
  ]);
  expect(commands.map((c: any) => c.payload.visible)).toEqual([false, true]);
  await expect(dialog.locator('textarea[name="content"]')).toHaveValue(
    "정보와 신뢰를 함께 생각한다",
  );
});
