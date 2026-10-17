import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { previewLibrary } from "../src/lib/preview-data";
test.use({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
const note = {
  id: "10000000-0000-4000-a000-000000000001",
  title: "한 번에 여는 메모",
  content: "본문을 눌러서 여는 기록",
  kind: "note",
  tags: ["신앙서적"],
  bookId: previewLibrary.books[0].id,
  version: 1,
  createdAt: "2018-02-15T11:15:08Z",
  updatedAt: "2018-02-15T11:15:08Z",
};
const book = {
  ...previewLibrary.books[0],
  title: "아주 긴 책 제목 ".repeat(30),
};
const fixture = {
  books: [book],
  notes: [{ ...note, summary: true }],
  cycles: [],
  catalog: {
    total: 1,
    formatCounts: { paper: 1 },
    categoryCounts: {},
    firstPage: { items: [book], total: 1, nextCursor: null },
  },
  deletedNotes: [],
};
let bundle: string;
test.beforeAll(async () => {
  bundle = (
    await build({
      stdin: {
        contents: `import {createRoot} from 'react-dom/client';import {LibraryApp} from './src/components/library-app';createRoot(document.getElementById('root')).render(<LibraryApp initial={window.fixture} today="2026-10-17"/>);`,
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
async function mount(page: Page, detail?: () => Promise<void>) {
  await page.route("https://library.test/api/books?*", (r) =>
    r.fulfill({ json: { items: [book], total: 1, nextCursor: null } }),
  );
  await page.route("https://library.test/api/notes?*", (r) =>
    r.fulfill({
      json: { items: [{ ...note, summary: true }], total: 1, nextOffset: null },
    }),
  );
  await page.route("https://library.test/api/notes/" + note.id, async (r) => {
    await detail?.();
    await r.fulfill({ json: note }).catch(() => {});
  });
  await page.route("https://library.test/api/curation?*", (r) =>
    r.fulfill({
      json: { items: [], references: [], history: [], version: "1" },
    }),
  );
  await page.route("https://library.test/", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: '<html lang="ko"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>',
    }),
  );
  await page.goto("https://library.test/");
  await page.evaluate((v) => {
    (window as any).fixture = v;
  }, fixture);
  await page.addStyleTag({ path: "src/app/globals.css" });
  await page.addScriptTag({ content: bundle });
  await page.getByRole("button", { name: "메뉴 열기", exact: true }).tap();
  await page.getByRole("button", { name: "기록과 생각", exact: true }).tap();
  await expect(page.locator(".notes-grid .note-card")).toHaveCount(1);
}
test("one body tap opens immediately, fetches once and presents a fitting mobile editor", async ({
  page,
}) => {
  let release: () => void = () => {},
    calls = 0;
  const wait = new Promise<void>((r) => {
    release = r;
  });
  await mount(page, async () => {
    calls++;
    await wait;
  });
  await page.locator(".notes-grid .note-card > p").tap();
  await expect(
    page.getByRole("dialog", { name: "기록 불러오기", exact: true }),
  ).toBeVisible();
  expect(calls).toBe(1);
  release();
  const dialog = page.getByRole("dialog", { name: "기록 수정", exact: true });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("textbox", { name: "내용", exact: true }),
  ).toHaveValue(note.content);
  const bounds = await dialog.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844);
  expect(await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(
    true,
  );
  expect(
    await dialog
      .getByLabel("제목", { exact: true })
      .evaluate((e) => parseFloat(getComputedStyle(e).fontSize)),
  ).toBeGreaterThanOrEqual(16);
  await dialog.getByRole("button", { name: "닫기", exact: true }).tap();
  const start = await page
    .getByLabel("작성일 시작", { exact: true })
    .boundingBox();
  const kind = await page
    .getByRole("combobox", { name: "종류", exact: true })
    .boundingBox();
  expect(Math.abs(start!.height - kind!.height)).toBeLessThanOrEqual(1);
  expect(start!.x + start!.width).toBeLessThanOrEqual(390);
});
test("trash requires a second confirmation and sends only the shown trashed versions", async ({
  page,
}) => {
  let sent: any;
  await page.route("https://library.test/api/library", (r) =>
    r.fulfill({ json: {} }),
  );
  await page.route("https://trash.test/", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: '<html lang="ko"><div id="root"></div></html>',
    }),
  );
  await page.goto("https://trash.test/");
  const trashBundle = (
    await build({
      stdin: {
        contents: `import {createRoot} from 'react-dom/client';import {NoteTrash} from './src/components/note-trash';createRoot(document.getElementById('root')).render(<NoteTrash library={window.fixture} onSave={async(c)=>{window.sent=c;}}/>);`,
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
  await page.evaluate(
    (v) => {
      (window as any).fixture = v;
    },
    {
      ...fixture,
      deletedNotes: [
        { ...note, version: 2, deletedAt: "2026-10-17T00:00:00Z" },
      ],
    },
  );
  await page.addStyleTag({ path: "src/app/globals.css" });
  await page.addScriptTag({ content: trashBundle });
  await page.getByText("휴지통 · 1개", { exact: true }).tap();
  await page.getByRole("button", { name: "전체삭제", exact: true }).tap();
  expect(await page.evaluate(() => (window as any).sent)).toBeUndefined();
  await expect(
    page.getByRole("group", { name: "휴지통 전체삭제 확인" }),
  ).toContainText("복원할 수 없습니다");
  await page.getByRole("button", { name: "취소", exact: true }).tap();
  expect(await page.evaluate(() => (window as any).sent)).toBeUndefined();
  await page.getByRole("button", { name: "전체삭제", exact: true }).tap();
  await page.getByRole("button", { name: "영구 삭제", exact: true }).tap();
  sent = await page.evaluate(() => (window as any).sent);
  expect(sent.type).toBe("emptyNoteTrash");
  expect(sent.payload.notes).toEqual([{ id: note.id, expectedVersion: 2 }]);
});
test("closing note loading cancels opening even after the delayed response completes", async ({
  page,
}) => {
  let release: () => void = () => {};
  const wait = new Promise<void>((r) => {
    release = r;
  });
  await mount(page, () => wait);
  await page.locator(".notes-grid .note-card > p").tap();
  const loading = page.getByRole("dialog", {
    name: "기록 불러오기",
    exact: true,
  });
  await expect(loading).toBeVisible();
  await loading.getByRole("button", { name: "닫기", exact: true }).tap();
  release();
  await expect(loading).toHaveCount(0);
  await expect(
    page.getByRole("dialog", { name: "기록 수정", exact: true }),
  ).toHaveCount(0);
  // A cancelled load must not leave a pending flag that prevents reopening.
  await page.locator(".notes-grid .note-card > p").tap();
  await expect(
    page.getByRole("dialog", { name: "기록 수정", exact: true }),
  ).toBeVisible();
});
