import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { previewLibrary } from "../src/lib/preview-data";
import {
  buildTopicMaterials,
  pageTopicMaterials,
} from "../src/lib/topic-materials";
let bundle: string;
test.beforeAll(async () => {
  bundle = (
    await build({
      stdin: {
        contents: `import {createRoot} from 'react-dom/client';import {LibraryApp} from './src/components/library-app';createRoot(document.getElementById('root')).render(<LibraryApp initial={window.fixture} today="2026-10-25"/>);`,
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
async function mount(page: any) {
  const book = { ...previewLibrary.books[0], category: "100" },
    notes = [
      {
        ...previewLibrary.notes[0],
        id: crypto.randomUUID(),
        bookId: book.id,
        title: "독서한 생각",
        kind: "thought" as const,
        tags: ["관계"],
        content: "관계의 의미",
      },
      {
        ...previewLibrary.notes[0],
        id: crypto.randomUUID(),
        bookId: book.id,
        title: "발췌한 문장",
        kind: "highlight" as const,
        tags: ["인용"],
        content: "인용한 문장",
      },
    ],
    cycle = {
      ...previewLibrary.cycles[0],
      id: crypto.randomUUID(),
      bookId: book.id,
      status: "completed",
      completedOn: "2026-10-25",
    };
  const fixture = {
    ...previewLibrary,
    books: [book],
    notes,
    cycles: [cycle],
    deletedNotes: [],
  };
  await page.route("https://library.test/api/**", (r: any) => {
    const u = new URL(r.request().url());
    if (u.pathname === "/api/thought-map")
      return r.fulfill({
        json: {
          topics: [],
          memberships: [],
          topicLinks: [],
          notes,
          candidates: [],
          feedback: [],
        },
      });
    if (u.pathname === "/api/library-materials")
      return r.fulfill({
        json: pageTopicMaterials(
          buildTopicMaterials({
            books: [book],
            notes,
            topics: [],
            memberships: [],
          }) as any,
          Object.fromEntries(u.searchParams),
        ),
      });
    if (u.pathname === "/api/note-tags")
      return r.fulfill({
        json: [
          { tag: "관계", count: 1, activeCount: 1, fingerprint: "abc" },
          { tag: "인용", count: 1, activeCount: 1, fingerprint: "def" },
        ],
      });
    if (u.pathname === "/api/assist")
      return r.fulfill({
        json: { requests: [], workers: [], usage: [], policy: {} },
      });
    return r.fulfill({ json: fixture });
  });
  await page.route("https://library.test/", (r: any) =>
    r.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html lang="ko"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>',
    }),
  );
  await page.goto("https://library.test/");
  await page.evaluate((f: any) => ((window as any).fixture = f), fixture);
  await page.addStyleTag({ path: "src/app/globals.css" });
  await page.addScriptTag({ content: bundle });
  return { book, notes };
}
test("calendar offers book details next to date editing and book-add appears only in home/books", async ({
  page,
}) => {
  const f = await mount(page);
  await expect(
    page
      .locator(".page-heading")
      .getByRole("button", { name: "책 추가", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "메뉴 열기", exact: true }).click();
  await page.getByRole("button", { name: "독서 달력", exact: true }).click();
  await page.getByRole("button", { name: "2026-10-25", exact: true }).click();
  const row = page.locator(".completed-row").first();
  await row.getByRole("button", { name: "세부정보", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "책을 펼쳐 보기" }),
  ).toBeVisible();
  await expect(
    page
      .locator(".page-heading")
      .getByRole("button", { name: "책 추가", exact: true }),
  ).toHaveCount(0);
});
for (const width of [390, 1280])
  test(`unified notes have type, searchable book and tag filters at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await mount(page);
    await page.getByRole("button", { name: "메뉴 열기", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "기록과 생각", exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "사유의 지도", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "내 기록", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("combobox", { name: "자료 종류", exact: true }),
    ).toHaveCount(0);
    await expect(page.locator(".thought-card")).toHaveCount(2);
    await page
      .getByRole("combobox", { name: "종류", exact: true })
      .selectOption("highlight");
    await expect(page.locator(".thought-card")).toHaveCount(1);
    await expect(page.locator(".thought-card").first()).toContainText(
      "발췌한 문장",
    );
    await expect(
      page.locator(".topic-material-filters .page-size-select"),
    ).toHaveCount(0);
    await expect(
      page.locator(".topic-material-pagination .page-size-select"),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/unified-notes/unified-${width}.png`,
      fullPage: false,
    });
  });
