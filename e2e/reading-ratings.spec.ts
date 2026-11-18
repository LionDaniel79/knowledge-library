import { test, expect } from "@playwright/test";
import { build } from "esbuild";
const id = "00000000-0000-4000-a000-000000000001";
async function mount(page: any, contents: string) {
  await page.route("https://library.test/", (r: any) =>
    r.fulfill({
      contentType: "text/html",
      body: '<html lang="ko"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>',
    }),
  );
  await page.goto("https://library.test/");
  await page.addStyleTag({ path: "src/app/globals.css" });
  const bundle = await build({
    stdin: { contents, resolveDir: process.cwd(), loader: "tsx" },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
}
const setup = `import {createRoot} from 'react-dom/client';import {useState} from 'react';import {LibraryForm} from './src/components/library-forms'; const book={id:'${id}',title:'테스트 책',author:'저자',formats:['paper'],tags:[],isbn:'',publisher:'',shelf:'',version:1};const cycle={id:'${id}',bookId:book.id,status:'reading',startedOn:'2026-11-01',completedOn:null,currentPage:20,version:1,createdAt:'2026-11-01'};const library={books:[book],cycles:[cycle],notes:[],revisions:[],shelves:[]};`;
for (const width of [390, 1100])
  test(`half stars, zero and unrated saved distinctly at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await mount(
      page,
      setup +
        `createRoot(document.getElementById('root')).render(<LibraryForm editor={{kind:'complete',cycle}} library={library} today="2026-11-18" preview={false} onClose={()=>{}} onSave={async c=>{window.saved=c}}/>);`,
    );
    await page.getByRole("radio", { name: "3.5점", exact: true }).click();
    await expect(
      page.getByRole("radio", { name: "3.5점", exact: true }),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      await page
        .locator(".rating-choice-star")
        .nth(3)
        .locator(".rating-star-fill")
        .evaluate((e: any) => e.style.width),
    ).toBe("50%");
    await page.getByRole("button", { name: "완독 저장" }).click();
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).saved?.payload.ratingSteps),
      )
      .toBe(7);
    await page.getByRole("radio", { name: "0점", exact: true }).click();
    await page.getByRole("button", { name: "완독 저장" }).click();
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).saved?.payload.ratingSteps),
      )
      .toBe(0);
    await page.getByRole("radio", { name: "평가 안 함" }).click();
    await page.getByRole("button", { name: "완독 저장" }).click();
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).saved?.payload.ratingSteps),
      )
      .toBeNull();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath("completion-rating.png"),
      fullPage: true,
    });
  });
test("undated completion, rating-only edit, keyboard and failed retry preserve dates and selection", async ({
  page,
}) => {
  await mount(
    page,
    setup +
      `createRoot(document.getElementById('root')).render(<LibraryForm editor={{kind:'start',book}} library={library} today="2026-11-18" preview={false} onClose={()=>{}} onSave={async c=>{window.saved=c;window.attempt=(window.attempt??0)+1;if(window.attempt===1)throw Error('재시도');}}/>);`,
  );
  await page.getByRole("button", { name: "완독", exact: true }).click();
  await expect(page.locator("input[type=date]")).toHaveCount(0);
  await page.getByRole("radio", { name: "0점", exact: true }).click();
  await page.getByRole("button", { name: "완독 저장" }).click();
  await expect(page.getByRole("alert")).toHaveText("재시도");
  await expect(
    page.getByRole("radio", { name: "0점", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  const first = await page.evaluate(() => (window as any).saved.requestId);
  await page.getByRole("button", { name: "완독 저장" }).click();
  expect(await page.evaluate(() => (window as any).saved.requestId)).toBe(
    first,
  );
  expect(await page.evaluate(() => (window as any).saved.payload)).toEqual({
    bookId: id,
    startedOn: null,
    completedWithoutDates: true,
    ratingSteps: 0,
  });
  await mount(
    page,
    setup +
      `createRoot(document.getElementById('root')).render(<LibraryForm editor={{kind:'rating',cycle:{...cycle,status:'completed',ratingSteps:7}}} library={library} today="2026-11-18" preview={false} onClose={()=>{}} onSave={async c=>{window.saved=c}}/>);`,
  );
  await expect(page.locator("input[type=date]")).toHaveCount(0);
  await page.getByRole("radio", { name: "3.5점", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("radio", { name: "4점", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "저장하기" }).click();
  expect(await page.evaluate(() => (window as any).saved)).toMatchObject({
    type: "rateReading",
    payload: { ratingSteps: 8 },
  });
});
for (const width of [390, 1100])
  test(`rating statistics filtering and half-star display ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await mount(
      page,
      `import {createRoot} from 'react-dom/client';import {RatingStatistics} from './src/components/rating-statistics';const books=[0,1,2].map(n=>({id:String(n),title:'완독 책 '+n,author:'저자',formats:['paper'],tags:[]}));const cycles=books.map((b,n)=>({id:b.id,bookId:b.id,status:'completed',completedOn:n===2?null:'2026-11-01',createdAt:'2026-11-01',ratingSteps:[7,0,null][n]}));createRoot(document.getElementById('root')).render(<main><RatingStatistics library={{books,cycles,notes:[],revisions:[]}} today="2026-11-18" onOpenBook={id=>window.opened=id} onRate={()=>{}}/></main>);`,
    );
    await expect(page.locator(".rating-books article")).toHaveCount(3);
    await expect(page.getByLabel("3.5점", { exact: true })).toBeVisible();
    expect(
      await page
        .getByLabel("3.5점", { exact: true })
        .locator(".rating-star")
        .count(),
    ).toBe(4);
    await expect(page.locator(".stat-card").first()).toContainText("1.8");
    await page.getByLabel("별점 연도").selectOption("2026");
    await expect(page.locator(".rating-books article")).toHaveCount(2);
    await page
      .locator(".rating-filters")
      .getByRole("button", { name: "0–0.5점", exact: true })
      .click();
    await expect(page.locator(".rating-books article")).toHaveCount(1);
    await page.getByRole("button", { name: "완독 책 1 저자" }).click();
    expect(await page.evaluate(() => (window as any).opened)).toBe("1");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page
      .locator(".rating-filters")
      .getByRole("button", { name: "전체", exact: true })
      .click();
    await page.screenshot({
      path: test.info().outputPath("rating-statistics.png"),
      fullPage: true,
    });
  });
test("shows the competing rating before confirming a stale draft", async ({
  page,
}) => {
  await mount(
    page,
    setup +
      `createRoot(document.getElementById('root')).render(<LibraryForm editor={{kind:'rating',cycle:{...cycle,status:'completed',ratingSteps:7}}} library={{...library,cycles:[{...cycle,status:'completed',version:2,ratingSteps:10}]}} today="2026-11-18" preview={false} onClose={()=>{}} onSave={async()=>{const e=Error('다른 기기에서 수정');e.status=409;throw e}}/>);`,
  );
  await page.getByRole("button", { name: "저장하기" }).click();
  await expect(
    page.getByTestId("conflict-latest").getByLabel("5점", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("radio", { name: "3.5점", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
});
