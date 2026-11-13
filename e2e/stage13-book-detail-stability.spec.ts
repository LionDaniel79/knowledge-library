import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import sharp from "sharp";

let bundle: string;
test.beforeAll(async () => {
  const image = (
    await sharp({
      create: { width: 60, height: 90, channels: 3, background: "#274b40" },
    })
      .webp()
      .toBuffer()
  ).toString("base64");
  const updatedImage = (
    await sharp({
      create: { width: 60, height: 90, channels: 3, background: "#9e2c27" },
    })
      .webp()
      .toBuffer()
  ).toString("base64");
  bundle = (
    await build({
      stdin: {
        contents: `import {createRoot} from 'react-dom/client';
import {useEffect,useState} from 'react';
import {LibraryApp} from './src/components/library-app';
import {ReplicaProvider} from './src/components/replica/provider';
import {createMemoryReplica} from './src/client/replica/memory-storage';
import {createLibraryRuntime} from './src/client/replica/runtime';
import {createSyncCursor} from './src/lib/replica/contracts';
window.mount=async()=>{
 const owner='detail-owner',epoch=crypto.randomUUID(),storage=createMemoryReplica(owner);
 const g=await storage.createGeneration({epoch,cursor:createSyncCursor({owner,epoch,after:'1'})});
 const asset='10000000-0000-4000-a000-000000000001',id='20000000-0000-4000-a000-000000000001';
 let book={id,title:'동기화 중 읽는 책',author:'저자',publisher:'처음 출판사',isbn:'',formats:['paper'],total_pages:200,shelf:'',tags:[],category:'100',classification:{source:'수동'},bookshelves:[],cover_url:'/api/book-covers/'+asset,enrichment:{},version:1,created_at:'2026-10-17T01:00:00Z',source_data:null};
 async function put(entity,value,revision){const inline=JSON.stringify(value),bytes=new TextEncoder().encode(inline),sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');await storage.stageRows(g.generation,[{entity,key:JSON.stringify([value.id]),revision,deleted:false,sha256,bytes:bytes.length,inline}]);}
 await put('library_books',book,'1');
 await put('library_cover_assets',{id:asset,mime:'image/webp',data_base64:${JSON.stringify(image)}},'1');
 await storage.setCheckpoint(g.generation,{complete:true,changeOrderVersion:2});await storage.promoteGeneration(g.generation);
 const runtime=createLibraryRuntime(owner,storage,await storage.checkpoint());
 const read=runtime.repository.read.bind(runtime.repository);
 let releaseDetail,releaseCover,detailGate,coverGate;
 const calls=[];
 runtime.repository.read=async(path)=>{calls.push(path);if(path==='/api/books/'+id&&detailGate)await detailGate;return read(path);};
 const readRow=storage.readRow.bind(storage);
 storage.readRow=async(...args)=>{if(args[0]==='library_cover_assets'&&coverGate)await coverGate;return readRow(...args);};
 function App(){const [initial,setInitial]=useState(null);useEffect(()=>{let revision=-1;const refresh=()=>{const next=runtime.getSnapshot();if(next.revision!==revision){revision=next.revision;void runtime.repository.overview().then(setInitial);}};refresh();return runtime.subscribe(refresh);},[]);return <ReplicaProvider runtime={runtime}>{initial&&<LibraryApp initial={initial} today="2026-10-17" ownerId={owner} initialView="books"/>}</ReplicaProvider>;}
 const root=createRoot(document.getElementById('root'));
 window.device={epoch,calls,runtime,unmount(){root.unmount();runtime.close();},hold(){detailGate=new Promise(resolve=>releaseDetail=resolve);coverGate=new Promise(resolve=>releaseCover=resolve);},release(){detailGate=undefined;coverGate=undefined;releaseDetail?.();releaseCover?.();},async change(){book={...book,publisher:'새 출판사',version:2};await put('library_books',book,'2');await runtime.notifyLocalChange();},async changeCover(){await put('library_cover_assets',{id:asset,mime:'image/webp',data_base64:${JSON.stringify(updatedImage)}},'3');await runtime.notifyLocalChange();}};
 root.render(<App/>);
};`,
        loader: "tsx",
        resolveDir: process.cwd(),
      },
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      jsx: "automatic",
      define: {
        "process.env.NODE_ENV": '"production"',
        "import.meta.url": '"https://detail.test/app.js"',
      },
    })
  ).outputFiles[0].text;
});

test("keeps the open detail, cover, scroll and pending shelf selection through sync and a data revision", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const create = URL.createObjectURL.bind(URL),
      revoke = URL.revokeObjectURL.bind(URL);
    (window as any).imageUrls = {
      created: [] as string[],
      revoked: [] as string[],
    };
    URL.createObjectURL = (blob) => {
      const url = create(blob);
      (window as any).imageUrls.created.push(url);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      (window as any).imageUrls.revoked.push(url);
      revoke(url);
    };
  });
  let releaseMeta!: () => void;
  const metaGate = new Promise<void>((resolve) => {
    releaseMeta = resolve;
  });
  let checks = 0;
  await page.route("https://detail.test/", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div>',
    }),
  );
  await page.route("https://detail.test/api/**", (r) =>
    r.fulfill({ status: 503, json: { error: "fixture offline" } }),
  );
  await page.route("https://detail.test/api/sync/session", (r) =>
    r.fulfill({ json: { ownerId: "detail-owner" } }),
  );
  await page.route("https://detail.test/api/auth/get-session", (r) =>
    r.fulfill({
      json: {
        user: { id: "detail-owner" },
        session: { id: "fixture-session" },
      },
    }),
  );
  await page.route("https://detail.test/api/sync/meta?*", async (r) => {
    checks++;
    await metaGate;
    const epoch = await page.evaluate(() => (window as any).device.epoch);
    return r.fulfill({
      json: {
        epoch,
        head: "1",
        floor: "0",
        protocol: 1,
        entities: {},
        totalRows: 2,
        totalBytes: 1,
      },
    });
  });
  await page.goto("https://detail.test/");
  await page.addStyleTag({ path: "src/app/globals.css" });
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => (window as any).mount());
  await page.locator(".shelf-card").click();
  const dialog = page.getByRole("dialog", {
    name: "책을 펼쳐 보기",
    exact: true,
  });
  await expect(
    dialog.getByRole("button", { name: "수정", exact: true }),
  ).toBeEnabled();
  const image = dialog.locator(".book-cover img");
  await expect(image).toHaveAttribute("src", /^blob:/);
  await expect
    .poll(() =>
      image.evaluate(
        (img: HTMLImageElement) => img.complete && img.naturalWidth > 0,
      ),
    )
    .toBe(true);
  await dialog.locator(".detail-shelves .shelf-dropdown-trigger").click();
  const choice = dialog.getByRole("checkbox", {
    name: "책 대기열",
    exact: true,
  });
  await choice.check();
  const before = await page.evaluate(() => {
    const d = document.querySelector("dialog.book-detail-modal")!;
    const cover = d.querySelector(".book-cover img")!;
    d.scrollTop = 170;
    (window as any).savedDetail = {
      dialog: d,
      cover,
      src: cover.getAttribute("src"),
      scroll: d.scrollTop,
    };
    return { scroll: d.scrollTop, calls: (window as any).device.calls.length };
  });
  expect(before.scroll).toBeGreaterThan(0);
  await page.evaluate(() => {
    void (window as any).device.runtime.sync({ reason: "manual" });
  });
  await expect.poll(() => checks).toBe(1);
  await expect(
    page.getByRole("button", { name: "동기화", exact: true }),
  ).toBeDisabled();
  expect(await page.evaluate(() => (window as any).device.calls.length)).toBe(
    before.calls,
  );
  releaseMeta();
  await expect(
    page.getByRole("button", { name: "동기화", exact: true }),
  ).toBeEnabled();
  expect(await page.evaluate(() => (window as any).device.calls.length)).toBe(
    before.calls,
  );

  await page.evaluate(async () => {
    (window as any).device.hold();
    await (window as any).device.change();
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).device.calls.filter((p: string) =>
            /^\/api\/books\/[^/]+$/.test(p),
          ).length,
      ),
    )
    .toBe(2);
  const retained = () =>
    page.evaluate(() => {
      const s = (window as any).savedDetail,
        d = document.querySelector("dialog.book-detail-modal");
      return {
        dialog: d === s.dialog,
        cover: d?.querySelector(".book-cover img") === s.cover,
        src: d?.querySelector(".book-cover img")?.getAttribute("src") === s.src,
        scroll: d?.scrollTop,
      };
    });
  expect(await retained()).toEqual({
    dialog: true,
    cover: true,
    src: true,
    scroll: before.scroll,
  });
  await expect(choice).toBeChecked();
  await expect(dialog).toContainText("처음 출판사");
  await page.evaluate(() => (window as any).device.release());
  await expect(dialog).toContainText("새 출판사");
  expect(await retained()).toEqual({
    dialog: true,
    cover: true,
    src: true,
    scroll: before.scroll,
  });
  await expect(choice).toBeChecked();
  const previousCover = await image.getAttribute("src");
  await page.evaluate(() => (window as any).device.changeCover());
  await expect(image).not.toHaveAttribute("src", previousCover!);
  await expect(image).toHaveAttribute("src", /^blob:/);
  await expect
    .poll(() =>
      image.evaluate(
        (img: HTMLImageElement) => img.complete && img.naturalWidth > 0,
      ),
    )
    .toBe(true);
  expect(
    await page.evaluate(
      () =>
        document.querySelector("dialog.book-detail-modal .book-cover img") ===
        (window as any).savedDetail.cover,
    ),
  ).toBe(true);
  await page.evaluate(() => (window as any).device.unmount());
  expect(
    await page.evaluate(() => {
      const urls = (window as any).imageUrls;
      return urls.created.every((url: string) => urls.revoked.includes(url));
    }),
  ).toBe(true);
});
