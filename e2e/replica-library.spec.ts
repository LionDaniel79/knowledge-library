import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import sharp from "sharp";
let bundle: string, worker: string, image: string;
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
        contents: `import {createRoot} from 'react-dom/client';import {ReplicaEntry} from './src/components/replica/entry';import {openReplica} from './src/client/replica/indexed-db';import {createSyncCursor} from './src/lib/replica/contracts';import {offlineOwnerKey} from './src/lib/offline-drafts';window.mountLibrary=async()=>{const f=window.fixture,s=await openReplica(f.owner),cursor=createSyncCursor({owner:f.owner,epoch:f.epoch,after:'1'}),g=await s.createGeneration({epoch:f.epoch,cursor});const rows=[];for(const r of f.records){const inline=JSON.stringify(r.value),bytes=new TextEncoder().encode(inline),sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');rows.push({entity:r.entity,key:JSON.stringify([r.value.id]),revision:'1',deleted:false,sha256,bytes:bytes.length,inline});}await s.stageRows(g.generation,rows);await s.setCheckpoint(g.generation,{complete:true,rows:rows.length});await s.promoteGeneration(g.generation);s.close();localStorage.setItem(offlineOwnerKey,f.owner);createRoot(document.getElementById('root')).render(<ReplicaEntry available={true} today="2026-10-17"/>);};`,
        resolveDir: process.cwd(),
        loader: "tsx",
      },
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      jsx: "automatic",
      define: {
        "process.env.NODE_ENV": '"production"',
        "import.meta.url": '"https://replica.test/assets/main.js"',
      },
    })
  ).outputFiles[0].text;
  worker = (
    await build({
      entryPoints: ["src/client/replica/search-worker.ts"],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
    })
  ).outputFiles[0].text;
});
test("puts real change synchronization left of add book and opens local books, images, full notes and history when list APIs are unavailable", async ({
  page,
}) => {
  const owner = "ui-owner",
    epoch = crypto.randomUUID(),
    book = crypto.randomUUID(),
    note = crypto.randomUUID(),
    asset = crypto.randomUUID(),
    date = "2026-10-17T01:00:00Z",
    content = "내 생각 ".repeat(80) + "원문 끝 문장";
  let heads = 0,
    blockedReads = 0;
  const records = [
    {
      entity: "library_books",
      value: {
        id: book,
        title: "개성의 탄생",
        author: "김 저자",
        publisher: "출판사",
        isbn: "",
        formats: ["paper"],
        total_pages: 200,
        shelf: "",
        tags: [],
        category: "100",
        classification: {},
        bookshelves: [],
        cover_url: "/api/book-covers/" + asset,
        enrichment: {},
        version: 1,
        created_at: date,
        source_data: null,
      },
    },
    {
      entity: "library_notes",
      value: {
        id: note,
        book_id: book,
        title: "내 독서 메모",
        content,
        kind: "thought",
        page: null,
        tags: ["독서 메모"],
        version: 1,
        created_at: date,
        updated_at: date,
        source_data: null,
      },
    },
    {
      entity: "library_cover_assets",
      value: {
        id: asset,
        sha256: "a".repeat(64),
        data_base64: image,
        mime: "image/webp",
        created_at: date,
      },
    },
    {
      entity: "library_revisions",
      value: {
        id: crypto.randomUUID(),
        entity_id: note,
        action: "addNote",
        before_data: null,
        after_data: { content: "처음 생각" },
        created_at: date,
      },
    },
  ];
  await page.route("https://replica.test/", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: '<html lang="ko"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>',
    }),
  );
  await page.route("https://replica.test/assets/search-worker.ts", (r) =>
    r.fulfill({ contentType: "text/javascript", body: worker }),
  );
  await page.route("https://replica.test/api/**", (r) => {
    const path = new URL(r.request().url()).pathname;
    if (
      /^\/api\/(library$|books|notes|reading|revisions|book-covers|note-tags)/.test(
        path,
      )
    )
      blockedReads++;
    return r.fulfill({
      status: 503,
      json: { error: "online data unavailable" },
    });
  });
  await page.route("https://replica.test/api/sync/session", (r) =>
    r.fulfill({ json: { ownerId: owner } }),
  );
  await page.route("https://replica.test/api/sync/meta?*", async (r) => {
    heads++;
    await new Promise((resolve) => setTimeout(resolve, 100));
    return r.fulfill({
      json: {
        epoch,
        head: "1",
        floor: "0",
        protocol: 1,
        entities: {},
        totalRows: 0,
        totalBytes: 0,
      },
    });
  });
  await page.goto("https://replica.test/");
  await page.evaluate((f) => ((window as any).fixture = f), {
    owner,
    epoch,
    records,
  });
  await page.addStyleTag({ path: "src/app/globals.css" });
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => (window as any).mountLibrary());
  const sync = page.getByRole("button", { name: "동기화", exact: true }),
    add = page.getByRole("button", { name: "책 추가", exact: true });
  await expect(sync).toBeEnabled();
  const a = await sync.boundingBox(),
    b = await add.boundingBox();
  expect(a!.x + a!.width).toBeLessThanOrEqual(b!.x + 1);
  expect(Math.abs(a!.y - b!.y)).toBeLessThan(2);
  const before = heads;
  await sync.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect(sync).toBeDisabled();
  await expect(sync).toBeEnabled();
  expect(heads).toBe(before + 1);
  await expect(page.getByText("동기화 완료", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileSync = await sync.boundingBox(),
    mobileAdd = await add.boundingBox();
  expect(mobileSync!.x + mobileSync!.width).toBeLessThanOrEqual(
    mobileAdd!.x + 1,
  );
  expect(mobileAdd!.x + mobileAdd!.width).toBeLessThanOrEqual(390);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: ".superpowers/sdd/2026-10-17-full-device-sync/sync-button-mobile.png",
  });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole("button", { name: "메뉴 열기", exact: true }).click();
  await page.getByRole("button", { name: /^소장 도서(?:\s|$)/ }).click();
  await expect(page.locator(".shelf-card")).toHaveCount(1);
  await expect(page.locator(".shelf-card img")).toHaveAttribute(
    "src",
    /^blob:/,
  );
  await page.locator(".shelf-card").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await page.getByRole("button", { name: "메뉴 열기", exact: true }).click();
  await page.getByRole("button", { name: "기록과 생각", exact: true }).click();
  await page.locator(".notes-grid .note-card > p").click();
  await expect(
    page
      .getByRole("dialog", { name: "기록 수정", exact: true })
      .getByRole("textbox", { name: "내용", exact: true }),
  ).toHaveValue(content);
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await page
    .getByRole("button", { name: "내 독서 메모 수정 이력", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "기록의 수정 이력", exact: true }),
  ).toContainText("처음 생각");
  expect(blockedReads).toBe(0);
});
