import { build } from "esbuild";
import { expect, test, type Page } from "@playwright/test";
import { previewLibrary } from "../src/lib/preview-data";

let bundle: string;
let formBundle: string;
test.beforeAll(async () => {
  bundle = (
    await build({
      stdin: {
        contents: `import {useState} from 'react';import {createRoot} from 'react-dom/client';import {BookShelves} from './src/components/shelf-picker';function App(){const[book,setBook]=useState(window.book);const[shelves,setShelves]=useState(['보존','신학','신학 연구']);return <BookShelves book={book} library={{books:[book],cycles:[],notes:[],shelves}} preview={false} onSave={async c=>{window.commands.push(c);if(c.type==='editBook'){if(window.failSave)throw Error('저장 실패: 다시 시도해 주세요.');setBook(b=>({...b,bookshelves:c.payload.bookshelves,version:b.version+1}));}if(c.type==='createShelf')setShelves(s=>[...s,c.payload.name]);if(c.type==='deleteShelf'){setShelves(s=>s.filter(n=>n!==c.payload.name));setBook(b=>({...b,bookshelves:b.bookshelves.filter(n=>n!==c.payload.name),version:b.version+1}));}}}/>;}createRoot(document.getElementById('root')).render(<App/>);`,
        loader: "tsx",
        resolveDir: process.cwd(),
      },
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
    })
  ).outputFiles[0].text;
  formBundle = (
    await build({
      stdin: {
        contents: `import {createRoot} from 'react-dom/client';import {LibraryForm} from './src/components/library-forms';createRoot(document.getElementById('root')).render(<LibraryForm editor={{kind:'book',book:window.book}} library={{books:[window.book],cycles:[],notes:[],shelves:['보존','신학']}} today="2026-11-13" preview={false} onClose={()=>window.closedForm=true} onSave={async c=>{window.commands.push(c);if(c.type==='deleteShelf')await new Promise(resolve=>window.finishDelete=resolve);}}/>);`,
        loader: "tsx",
        resolveDir: process.cwd(),
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

async function mount(page: Page, form = false) {
  await page.route("https://shelf.test/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><button id="outside">바깥</button><div id="root"></div>',
    }),
  );
  await page.goto("https://shelf.test/");
  await page.evaluate(
    (book) => Object.assign(window, { book, commands: [], failSave: false }),
    {
      ...previewLibrary.books[0],
      bookshelves: ["보존"],
    },
  );
  await page.addStyleTag({ path: "src/app/globals.css" });
  await page.addScriptTag({ content: form ? formBundle : bundle });
  return page.locator(".shelf-picker");
}

test("filtered select all preserves hidden memberships and completes in one write", async ({
  page,
}) => {
  const picker = await mount(page);
  await picker.getByRole("button", { name: "책장 선택", exact: true }).click();
  await expect(picker.getByRole("textbox")).not.toBeFocused();
  await picker.getByLabel("신학", { exact: true }).check();
  expect(await page.evaluate(() => (window as any).commands)).toEqual([]);
  await picker.getByRole("textbox").fill("신학");
  await picker.getByLabel("전체선택", { exact: true }).check();
  await picker.getByRole("button", { name: "완료", exact: true }).click();
  await expect(
    picker.getByRole("button", { name: "책장 선택", exact: true }),
  ).toHaveAttribute("aria-expanded", "false");
  const commands = await page.evaluate(() => (window as any).commands);
  expect(commands).toHaveLength(1);
  expect(commands[0].type).toBe("editBook");
  expect(commands[0].payload.bookshelves).toEqual([
    "보존",
    "신학",
    "신학 연구",
  ]);
});

test("book editor preserves field drafts and advances only the shelf deletion base before final save", async ({
  page,
}) => {
  const picker = await mount(page, true);
  await page.getByLabel("책 제목").fill("삭제 전 작성한 제목 초안");
  await page.getByLabel("저자", { exact: true }).fill("저자 초안");
  await page.getByLabel("주제", { exact: true }).fill("개인 태그");
  await picker.getByRole("button", { name: "책장 선택", exact: true }).click();
  await picker.getByLabel("신학", { exact: true }).check();
  page.once("dialog", (dialog) => dialog.accept());
  await picker
    .getByRole("button", { name: "보존 책장 삭제", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "저장하기", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "닫기", exact: true }),
  ).toBeDisabled();
  await page.evaluate(() => (window as any).finishDelete());
  await expect(picker.getByLabel("신학", { exact: true })).toBeChecked();
  await expect(page.getByLabel("책 제목")).toHaveValue(
    "삭제 전 작성한 제목 초안",
  );
  await picker.getByRole("button", { name: "완료", exact: true }).click();
  await page.getByRole("button", { name: "저장하기", exact: true }).click();
  const commands = await page.evaluate(() => (window as any).commands);
  expect(commands.map((c: any) => c.type)).toEqual(["deleteShelf", "editBook"]);
  expect(commands[1].payload).toMatchObject({
    expectedVersion: 2,
    bookshelves: ["신학"],
    title: "삭제 전 작성한 제목 초안",
    author: "저자 초안",
    tags: ["개인 태그"],
  });
  expect(commands[1].editBase).toMatchObject({
    bookshelves: [],
    title: previewLibrary.books[0].title,
    author: previewLibrary.books[0].author,
  });
});

test("clearing to unclassified is saved only on completion and a failed save preserves the draft", async ({
  page,
}) => {
  const picker = await mount(page);
  await picker.getByRole("button", { name: "책장 선택", exact: true }).click();
  await picker.getByLabel("미분류", { exact: true }).check();
  await expect(picker.getByLabel("보존", { exact: true })).not.toBeChecked();
  await page.evaluate(() => ((window as any).failSave = true));
  await picker.getByRole("button", { name: "완료", exact: true }).click();
  await expect(picker.getByRole("alert")).toContainText("저장 실패");
  await expect(picker.getByLabel("미분류", { exact: true })).toBeChecked();
  await page.evaluate(() => ((window as any).failSave = false));
  await picker.getByRole("button", { name: "완료", exact: true }).click();
  await expect(
    picker.getByRole("button", { name: "책장 선택", exact: true }),
  ).toHaveAttribute("aria-expanded", "false");
  const commands = await page.evaluate(() => (window as any).commands);
  expect(commands).toHaveLength(2);
  expect(commands[1].payload.bookshelves).toEqual([]);
});

test("new shelf creation selects it without losing memberships; unchanged completion makes no write", async ({
  page,
}) => {
  const picker = await mount(page);
  const trigger = picker.getByRole("button", {
    name: "책장 선택",
    exact: true,
  });
  await trigger.click();
  await picker.getByRole("button", { name: "완료", exact: true }).click();
  expect(await page.evaluate(() => (window as any).commands)).toEqual([]);
  await trigger.click();
  await picker.getByRole("textbox").fill("새 책장");
  await picker.getByRole("button", { name: "생성", exact: true }).click();
  await expect(picker.getByLabel("새 책장", { exact: true })).toBeChecked();
  await expect(picker.getByLabel("보존", { exact: true })).toBeChecked();
  await picker.getByRole("button", { name: "완료", exact: true }).click();
  const commands = await page.evaluate(() => (window as any).commands);
  expect(commands.map((c: any) => c.type)).toEqual(["createShelf", "editBook"]);
  expect(commands[1].payload.bookshelves).toEqual(["보존", "새 책장"]);
});

test("shelf deletion requires confirmation and protects virtual and built-in shelves", async ({
  page,
}) => {
  const picker = await mount(page);
  await picker.getByRole("button", { name: "책장 선택", exact: true }).click();
  await expect(
    picker.getByRole("button", { name: "미분류 책장 삭제", exact: true }),
  ).toHaveCount(0);
  await expect(
    picker.getByRole("button", { name: "책 대기열 책장 삭제", exact: true }),
  ).toHaveCount(0);
  await picker.getByLabel("신학", { exact: true }).check();
  page.once("dialog", (dialog) => dialog.dismiss());
  await picker
    .getByRole("button", { name: "보존 책장 삭제", exact: true })
    .click();
  expect(await page.evaluate(() => (window as any).commands)).toEqual([]);
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("모든 도서");
    expect(dialog.message()).toContain("데이터는 삭제하지 않습니다");
    await dialog.accept();
  });
  await picker
    .getByRole("button", { name: "보존 책장 삭제", exact: true })
    .click();
  await expect(picker.getByLabel("보존", { exact: true })).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as any).commands.map((c: any) => c.type)),
  ).toEqual(["deleteShelf"]);
  await expect(picker.getByLabel("신학", { exact: true })).toBeChecked();
  await picker.getByRole("button", { name: "완료", exact: true }).click();
  const saved = await page.evaluate(() => (window as any).commands[1]);
  expect(saved.payload.bookshelves).toEqual(["신학"]);
  expect(saved.payload.expectedVersion).toBe(2);
});

test("mobile opening keeps keyboard unfocused and escape or outside cancels unsaved selection", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const picker = await mount(page);
  const trigger = picker.getByRole("button", {
    name: "책장 선택",
    exact: true,
  });
  await trigger.click();
  await expect(picker.getByRole("textbox")).not.toBeFocused();
  await picker.getByLabel("신학", { exact: true }).check();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(picker.getByLabel("신학", { exact: true })).not.toBeChecked();
  await picker.getByLabel("신학", { exact: true }).check();
  await page.locator("#outside").click();
  await trigger.click();
  await expect(picker.getByLabel("신학", { exact: true })).not.toBeChecked();
  expect(await page.evaluate(() => (window as any).commands)).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
