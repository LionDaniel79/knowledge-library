import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import sharp from "sharp";

let bundle: string, image: string;
const asset = "10000000-0000-4000-a000-000000000001";
const coverUrl = "/api/book-covers/" + asset;
test.beforeAll(async () => {
  image = (
    await sharp({
      create: { width: 60, height: 90, channels: 3, background: "#274b40" },
    })
      .webp()
      .toBuffer()
  ).toString("base64");
  bundle = (
    await build({
      stdin: {
        contents: `import {createRoot} from 'react-dom/client';
import {ReplicaProvider} from './src/components/replica/provider';
import {BookCover} from './src/components/book-cover';
import {CoverInput} from './src/components/cover-input';
import {openReplica} from './src/client/replica/indexed-db';
import {createLibraryRuntime} from './src/client/replica/runtime';
window.mount=async(f)=>{
 const storage=await openReplica('cover-owner'),g=await storage.createGeneration({epoch:crypto.randomUUID(),cursor:'start'});
 if(f.local){const inline=JSON.stringify({id:f.asset,mime:'image/webp',data_base64:f.local==='corrupt'?'bm90LWFuLWltYWdl':f.image});
 await storage.stageRows(g.generation,[{entity:'library_cover_assets',key:JSON.stringify([f.asset]),revision:'1',deleted:false,sha256:'a'.repeat(64),bytes:new TextEncoder().encode(inline).length,inline}]);}
 await storage.setCheckpoint(g.generation,{complete:true});await storage.promoteGeneration(g.generation);
 const runtime=createLibraryRuntime('cover-owner',storage,await storage.checkpoint());
 const book={id:'20000000-0000-4000-a000-000000000001',title:'예루살렘의 아이히만',author:'한나 아렌트',tags:[],coverUrl:f.missingMirror?'https://origin.invalid/manual.jpg':'',catalogCoverUrl:f.missingMirror?undefined:f.url};
 createRoot(document.getElementById('root')).render(<ReplicaProvider runtime={runtime}><BookCover book={book}/>{!f.offline&&<CoverInput value="" previewUrl={f.url} preview={false} onChange={()=>{}} onBusy={()=>{}}/>}</ReplicaProvider>);
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
        "import.meta.url": '"https://covers.test/app.js"',
      },
    })
  ).outputFiles[0].text;
});
async function mount(
  page: Page,
  local: false | true | "corrupt" = false,
  serverStatus = 200,
  options: { missingMirror?: boolean; offline?: boolean } = {},
) {
  const requests: string[] = [];
  await page.route("https://covers.test/", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div>',
    }),
  );
  await page.route("https://covers.test/api/book-covers/**", (r) => {
    requests.push(new URL(r.request().url()).pathname);
    return r.fulfill(
      serverStatus === 200
        ? { contentType: "image/webp", body: Buffer.from(image, "base64") }
        : { status: serverStatus, body: "unavailable" },
    );
  });
  await page.route("https://covers.test/api/books/*/cover", (r) =>
    r.fulfill({
      contentType: "image/webp",
      body: Buffer.from(image, "base64"),
    }),
  );
  await page.goto("https://covers.test/");
  await page.addStyleTag({ path: "src/app/globals.css" });
  await page.addScriptTag({ content: bundle });
  await page.evaluate((f) => (window as any).mount(f), {
    local,
    asset,
    image,
    url: coverUrl,
    ...options,
  });
  return requests;
}
const loaded = (page: Page, selector: string) =>
  expect
    .poll(() =>
      page
        .locator(selector)
        .evaluate(
          (img: HTMLImageElement) => img.complete && img.naturalWidth > 0,
        ),
    )
    .toBe(true);

test("shows the server cover in both the book and editor when its device image is missing", async ({
  page,
}) => {
  await mount(page);
  await loaded(page, ".cover-input-preview img");
  await expect(page.locator(".book-cover img")).toHaveAttribute(
    "src",
    coverUrl,
  );
  await loaded(page, ".book-cover img");
});

test("opens the saved book cover endpoint when only the original image address exists", async ({
  page,
}) => {
  await mount(page, false, 200, { missingMirror: true });
  await expect(page.locator(".book-cover img")).toHaveAttribute(
    "src",
    "/api/books/20000000-0000-4000-a000-000000000001/cover",
  );
  await loaded(page, ".book-cover img");
});

test("keeps valid device images local without downloading the displayed cover", async ({
  page,
}) => {
  const requests = await mount(page, true);
  await expect(page.locator(".book-cover img")).toHaveAttribute(
    "src",
    /^blob:/,
  );
  await loaded(page, ".book-cover img");
  // Only the separately rendered editor preview reads the server URL.
  expect(requests).toEqual([coverUrl]);
});

test("uses the server copy if the device image cannot be decoded", async ({
  page,
}) => {
  await mount(page, "corrupt");
  await loaded(page, ".cover-input-preview img");
  await expect(page.locator(".book-cover img")).toHaveAttribute(
    "src",
    coverUrl,
  );
  await loaded(page, ".book-cover img");
});

test("retains the placeholder when neither device nor server has the cover", async ({
  page,
}) => {
  await mount(page, false, 404);
  await expect(page.locator(".book-cover strong")).toHaveText(
    "예루살렘의 아이히만",
  );
  await expect(page.locator(".book-cover img")).toHaveCount(0);
});

test("does not request missing device covers while offline", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "onLine", { get: () => false }),
  );
  const requests = await mount(page, false, 200, { offline: true });
  await expect(page.locator(".book-cover strong")).toHaveText(
    "예루살렘의 아이히만",
  );
  expect(requests).toEqual([]);
});
