import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";

let bundle: string;
test.beforeAll(async () => {
  bundle = (
    await build({
      stdin: {
        contents: `
          import {createRoot} from 'react-dom/client';
          import {WritingBoardPanel} from './src/components/writing-board/panel';
          import {ReplicaProvider} from './src/components/replica/provider';
          import {createLibraryRuntime} from './src/client/replica/runtime';
          import {createMemoryReplica} from './src/client/replica/memory-storage';
          import {createReplicaRepository} from './src/client/replica/repository';
          import {queueReplicaCommand} from './src/client/replica/outbox';
          import {createSyncCursor} from './src/lib/replica/contracts';
          import {emptyBoard} from './src/lib/whiteboard';
          import {referenceThoughtBox} from './src/lib/shared-thought-boxes';
          (async()=>{
            const storage=createMemoryReplica('merge-device'),epoch=crypto.randomUUID();
            const g=await storage.createGeneration({epoch,cursor:createSyncCursor({owner:storage.owner,epoch,after:'0'})});
            await storage.setCheckpoint(g.generation,{complete:true,changeOrderVersion:2});
            await storage.promoteGeneration(g.generation);
            const repository=createReplicaRepository(storage);
            const send=(type,payload,path='/api/knowledge')=>queueReplicaCommand({storage,repository,path,body:{requestId:crypto.randomUUID(),type,payload}});
            const note=await send('addNote',{content:'원본 메모'},'/api/library');
            const box=await send('saveMemoBundle',{expectedVersion:0,title:'공유 원본',description:'원본 내용',noteIds:[note.id]});
            const a=await send('createResearch',{title:'첫 글감',kind:'thesis',question:''});
            const b=await send('createResearch',{title:'둘째 글감',kind:'thesis',question:''});
            const snapshot=await repository.read('/api/whiteboard');
            let original=await repository.raw('library_memo_bundles',box.id);
            if(window.legacy){
              await send('saveMemoBundle',{id:box.id,expectedVersion:1,title:'수정한 공유 원본',description:window.legacy==='conflict'?'다른 기기에서 보완한 내용':'원본 내용',noteIds:[note.id]});
              original=await repository.raw('library_memo_bundles',box.id);
              localStorage.setItem('library:shared-box-drafts:'+storage.owner,JSON.stringify([{id:box.id,expectedVersion:1,title:'수정한 공유 원본',description:'원본 내용',noteIds:[note.id],base:{title:'공유 원본',description:'원본 내용',noteIds:[note.id]},predecessor:window.legacy==='chained'?{requestId:crypto.randomUUID(),id:box.id,expectedVersion:1,title:'이전 저장 요청',description:'원본 내용',noteIds:[note.id]}:undefined}]));
            }
            for(const p of [a,b]){
              const data=referenceThoughtBox(emptyBoard(),original,snapshot);
              data.writing.excludedNoteIds=[];
              await send('saveWhiteboard',{boardId:p.id,expectedVersion:0,data});
            }
            const runtime=createLibraryRuntime(storage.owner,storage,await storage.checkpoint());
            const read=runtime.repository.read;
            const initialBundles=structuredClone(await repository.all('library_memo_bundles'));
            runtime.repository.read=async(path)=>{
              const result=await read(path);
              return window.holdEcho&&result?.bundles?{...result,bundles:structuredClone(initialBundles)}:result;
            };
            const queue=runtime.queue;
            let release; const gate=new Promise(r=>release=r);
            runtime.queue=async(path,body)=>{
              const result=await queue(path,body);
              if(!window.legacy&&body.type==='saveMemoBundle'&&!window.held){window.held=true;await gate;}
              return result;
            };
            window.fixture={a,b,box,storage,repository,runtime,release};
            createRoot(document.getElementById('root')).render(<ReplicaProvider runtime={runtime}><WritingBoardPanel ownerId={storage.owner} library={{books:[],notes:snapshot.notes,cycles:[]}} onOpen={()=>{}}/></ReplicaProvider>);
          })();
        `,
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

async function mountDevice(
  page: Page,
  legacy?: "acknowledged" | "chained" | "conflict",
  holdEcho = false,
) {
  await page.route("https://merge-device.test/**", (route) => {
    if (new URL(route.request().url()).pathname === "/")
      return route.fulfill({
        contentType: "text/html",
        body: '<html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>',
      });
    // Mutations and reads use the real device repository and outbox. Automatic
    // online synchronization remains disconnected from this isolated fixture.
    return route.fulfill({ status: 401, json: { error: "offline fixture" } });
  });
  await page.goto("https://merge-device.test/");
  await page.evaluate((mode) => Object.assign(window, mode), {
    legacy,
    holdEcho,
  });
  await page.addStyleTag({ path: "src/app/globals.css" });
  await page.addScriptTag({ content: bundle, type: "module" });
  await page.getByRole("button", { name: "첫 글감", exact: true }).click();
}

test("merges device projects after switching boards during a shared original save", async ({
  page,
}) => {
  await mountDevice(page);
  await page.getByLabel("목차 제목", { exact: true }).fill("수정한 공유 원본");
  await expect.poll(() => page.evaluate(() => (window as any).held)).toBe(true);
  const identity = await page.evaluate(async () => {
    const { storage } = (window as any).fixture;
    const draft = JSON.parse(
      localStorage.getItem("library:shared-box-drafts:merge-device")!,
    )[0];
    const edit = (await storage.listOutbox())
      .filter((e: any) => e.command.body.type === "saveMemoBundle")
      .at(-1);
    return { draft: draft.requestId, queued: edit.requestId };
  });
  expect(identity.draft).toBeTruthy();
  expect(identity.draft).toBe(identity.queued);
  await page.getByRole("button", { name: "둘째 글감", exact: true }).click();
  await expect(page.getByLabel("목차 제목", { exact: true })).toHaveValue(
    "수정한 공유 원본",
  );
  await page
    .getByRole("checkbox", { name: "첫 글감 합치기 선택", exact: true })
    .check();
  await page
    .getByRole("checkbox", { name: "둘째 글감 합치기 선택", exact: true })
    .check();
  await page
    .getByRole("button", { name: "선택 글감 합치기", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "글감 합치기", exact: true });
  await dialog
    .getByRole("textbox", { name: "합친 글감 제목", exact: true })
    .fill("새 합친 글감");
  await page.evaluate(() => (window as any).fixture.release());
  const merge = dialog.getByRole("button", {
    name: "새 글감으로 합치기",
    exact: true,
  });
  await expect(merge).toBeEnabled();
  await merge.click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "새 합친 글감", exact: true }),
  ).toBeVisible();
  const result = await page.evaluate(async () => {
    const { a, b, box, storage, repository } = (window as any).fixture;
    const outbox = await storage.listOutbox();
    return {
      projects: (await repository.all("library_research"))
        .map((p: any) => p.title)
        .sort(),
      originals: await Promise.all(
        [a, b].map(
          async (p) =>
            (await repository.raw("library_whiteboards", p.id)).data.writing
              .chapters[0].bundleId,
        ),
      ),
      box: await repository.raw("library_memo_bundles", box.id),
      originalId: box.id,
      saves: outbox.filter((e: any) => e.command.body.type === "saveMemoBundle")
        .length,
    };
  });
  expect(result.projects).toEqual(["둘째 글감", "새 합친 글감", "첫 글감"]);
  expect(result.originals).toEqual([result.originalId, result.originalId]);
  expect(result.box).toMatchObject({
    title: "수정한 공유 원본",
    description: "원본 내용",
    version: 2,
  });
  expect(result.saves).toBe(2); // Original creation plus one durable edit.
});

for (const holdEcho of [false, true])
  test(`chains a new shared draft after a board switch while the previous save awaits acknowledgement (${holdEcho ? "delayed" : "fresh"} source echo)`, async ({
    page,
  }) => {
    await mountDevice(page, undefined, holdEcho);
    await page
      .getByLabel("목차 제목", { exact: true })
      .fill("수정한 공유 원본");
    await expect
      .poll(() => page.evaluate(() => (window as any).held))
      .toBe(true);
    await page.getByRole("button", { name: "둘째 글감", exact: true }).click();
    await expect(page.getByLabel("목차 제목", { exact: true })).toHaveValue(
      "수정한 공유 원본",
    );
    await page.getByLabel("목차 제목", { exact: true }).fill("전환 후 새 입력");
    if (holdEcho) {
      // A further remount must restore the predecessor and the new operation ID.
      await page.getByRole("button", { name: "첫 글감", exact: true }).click();
      await expect(page.getByLabel("목차 제목", { exact: true })).toHaveValue(
        "전환 후 새 입력",
      );
    }
    for (const name of ["첫 글감 합치기 선택", "둘째 글감 합치기 선택"])
      await page.getByRole("checkbox", { name, exact: true }).check();
    await page
      .getByRole("button", { name: "선택 글감 합치기", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "글감 합치기",
      exact: true,
    });
    await dialog
      .getByRole("textbox", { name: "합친 글감 제목", exact: true })
      .fill("새 입력 합친 글감");
    await page.evaluate(() => (window as any).fixture.release());
    const merge = dialog.getByRole("button", {
      name: "새 글감으로 합치기",
      exact: true,
    });
    await expect(merge).toBeEnabled();
    await merge.click();
    await expect(dialog).toHaveCount(0);
    const state = await page.evaluate(async () => {
      const { box, storage, repository } = (window as any).fixture;
      return {
        box: await repository.raw("library_memo_bundles", box.id),
        edits: (await storage.listOutbox())
          .filter((e: any) => e.command.body.type === "saveMemoBundle")
          .map((e: any) => e.command.body),
        draft: localStorage.getItem("library:shared-box-drafts:merge-device"),
      };
    });
    expect(state.box).toMatchObject({
      title: "전환 후 새 입력",
      description: "원본 내용",
      version: 3,
    });
    expect(state.edits).toHaveLength(3);
    expect(state.edits[2].payload.expectedVersion).toBe(2);
    expect(state.edits[2].requestId).not.toBe(state.edits[1].requestId);
    expect(state.draft).toBeNull();
  });

test("a chained shared draft retains a real concurrent edit while the source echo is delayed", async ({
  page,
}) => {
  await mountDevice(page, undefined, true);
  await page.getByLabel("목차 제목", { exact: true }).fill("수정한 공유 원본");
  await expect.poll(() => page.evaluate(() => (window as any).held)).toBe(true);
  await page.getByRole("button", { name: "둘째 글감", exact: true }).click();
  await page.getByLabel("목차 제목", { exact: true }).fill("전환 후 내 입력");
  await page.evaluate(async () => {
    const { box, repository, runtime } = (window as any).fixture;
    const current = await repository.raw("library_memo_bundles", box.id);
    await runtime.queue("/api/knowledge", {
      requestId: crypto.randomUUID(),
      type: "saveMemoBundle",
      payload: {
        id: box.id,
        expectedVersion: 2,
        title: "다른 기기의 제목",
        description: "다른 기기가 보완한 원문",
        noteIds: current.note_ids,
      },
    });
  });
  for (const name of ["첫 글감 합치기 선택", "둘째 글감 합치기 선택"])
    await page.getByRole("checkbox", { name, exact: true }).check();
  await page
    .getByRole("button", { name: "선택 글감 합치기", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "글감 합치기", exact: true });
  await dialog
    .getByRole("textbox", { name: "합친 글감 제목", exact: true })
    .fill("충돌 보존 검증");
  await page.evaluate(() => (window as any).fixture.release());
  await expect(dialog).toContainText("기기에 저장된 내용이 변경되었습니다");
  await expect(
    dialog.getByRole("button", { name: "새 글감으로 합치기", exact: true }),
  ).toBeDisabled();
  const state = await page.evaluate(async () => {
    const { box, repository } = (window as any).fixture;
    return {
      box: await repository.raw("library_memo_bundles", box.id),
      draft: JSON.parse(
        localStorage.getItem("library:shared-box-drafts:merge-device")!,
      )[0],
      count: (await repository.all("library_research")).length,
    };
  });
  expect(state.box).toMatchObject({
    title: "다른 기기의 제목",
    description: "다른 기기가 보완한 원문",
    version: 3,
  });
  expect(state.draft).toMatchObject({
    title: "전환 후 내 입력",
    description: "원본 내용",
    expectedVersion: 2,
    base: { title: "수정한 공유 원본", description: "원본 내용" },
  });
  expect(state.count).toBe(2);
});

for (const legacy of ["acknowledged", "chained", "conflict"] as const)
  test(`a restored legacy shared draft ${legacy === "conflict" ? "retains a real device conflict" : legacy === "chained" ? "recognizes the identical durable edit before replaying its predecessor" : "recognizes the identical durable edit"} before merging`, async ({
    page,
  }) => {
    await mountDevice(page, legacy);
    for (const name of ["첫 글감 합치기 선택", "둘째 글감 합치기 선택"])
      await page.getByRole("checkbox", { name, exact: true }).check();
    await page
      .getByRole("button", { name: "선택 글감 합치기", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "글감 합치기",
      exact: true,
    });
    await dialog
      .getByRole("textbox", { name: "합친 글감 제목", exact: true })
      .fill("복구한 합친 글감");
    const merge = dialog.getByRole("button", {
      name: "새 글감으로 합치기",
      exact: true,
    });
    if (legacy === "conflict") {
      await expect(dialog).toContainText("기기에 저장된 내용이 변경되었습니다");
      await expect(merge).toBeDisabled();
    } else {
      await expect(merge).toBeEnabled();
      await merge.click();
      await expect(dialog).toHaveCount(0);
    }
    const state = await page.evaluate(async () => {
      const { box, repository } = (window as any).fixture;
      return {
        box: await repository.raw("library_memo_bundles", box.id),
        draft: localStorage.getItem("library:shared-box-drafts:merge-device"),
        count: (await repository.all("library_research")).length,
      };
    });
    expect(state.box).toMatchObject({
      title: "수정한 공유 원본",
      description:
        legacy === "conflict" ? "다른 기기에서 보완한 내용" : "원본 내용",
      version: 2,
    });
    expect(state.count).toBe(legacy === "conflict" ? 2 : 3);
    if (legacy === "conflict")
      expect(state.draft).toContain('"description":"원본 내용"');
    else expect(state.draft).toBeNull();
  });
