import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { previewLibrary } from "../src/lib/preview-data";
let bundle: string;
test.beforeAll(async () => {
  bundle = (
    await build({
      stdin: {
        contents: `import{createRoot}from'react-dom/client';import{LibraryApp}from'./src/components/library-app';import{LibrarySearchPanel}from'./src/components/library-search-panel';import{BookRelations}from'./src/components/book-relations';const root=createRoot(document.getElementById('root'));let version=0;window.render=()=>root.render(window.mode==='relations'?<BookRelations book={window.fixture.books[window.sourceIndex||0]} library={window.fixture}/>:window.mode==='search'?<LibrarySearchPanel key={version++} library={window.fixture} ownerId="test-owner" onOpen={(kind,id)=>window.opened={kind,id}}/>:<LibraryApp initial={window.fixture} today="2026-10-25"/>);window.render();`,
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
async function mount(page: Page, mode = "relations", withCandidate = false) {
  const books = ["첫번째 원본", "두번째 판본", "세번째 번역"].map(
    (title, i) => ({
      ...previewLibrary.books[0],
      id: crypto.randomUUID(),
      title,
      author: "저자" + i,
      publisher: "출판사" + i,
      version: i + 1,
    }),
  );
  const topic = crypto.randomUUID(),
    calls: any[] = [];
  const fixture = { ...previewLibrary, books, notes: [], cycles: [] };
  await page.route("https://library.test/api/**", async (r) => {
    const u = new URL(r.request().url());
    if (u.pathname === "/api/book-relations") {
      if (r.request().method() === "POST") {
        calls.push(r.request().postDataJSON());
        return r.fulfill({ json: { ok: true } });
      }
      const id = u.searchParams.get("bookId");
      return r.fulfill({
        json: {
          source: books.find((b) => b.id === id),
          candidates: withCandidate ? [books[2]] : [],
          relations: [],
          localAvailable: true,
        },
      });
    }
    if (u.pathname === "/api/books") {
      const q = u.searchParams.get("q") ?? "",
        exclude = u.searchParams.get("exclude");
      const items = books.filter(
        (b) =>
          b.id !== exclude &&
          (!q || [b.title, b.author, b.publisher].some((t) => t.includes(q))),
      );
      calls.push({ booksQuery: Object.fromEntries(u.searchParams) });
      return r.fulfill({ json: { items, total: items.length } });
    }
    if (u.pathname === "/api/library-search/topics")
      return r.fulfill({
        json: {
          topics: [{ id: topic, name: "관계", confirmed: true, aliases: [] }],
        },
      });
    if (u.pathname === "/api/note-tags")
      return r.fulfill({
        json: [{ tag: "공감", count: 1, activeCount: 1, fingerprint: "x" }],
      });
    if (u.pathname === "/api/notes" || u.pathname === "/api/library-search") {
      calls.push({ searchQuery: Object.fromEntries(u.searchParams) });
      return r.fulfill({ json: { items: [], total: 0 } });
    }
    if (u.pathname.startsWith("/api/books/"))
      return r.fulfill({
        json: books.find((b) => b.id === u.pathname.split("/").at(-1)),
      });
    return r.fulfill({
      json: {
        items: [],
        total: 0,
        topics: [],
        memberships: [],
        topicLinks: [],
      },
    });
  });
  await page.route("https://library.test/", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html lang="ko"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>',
    }),
  );
  await page.goto("https://library.test/");
  await page.evaluate((f) => Object.assign(window, f), { fixture, mode });
  await page.addStyleTag({ path: "src/app/globals.css" });
  await page.addScriptTag({ content: bundle });
  return { books, topic, calls };
}
test("relation search excludes the source, selects the first match and connects the chosen edition", async ({
  page,
}) => {
  const f = await mount(page);
  await page.getByText("다른 소장본·판본 연결", { exact: true }).click();
  await page.getByText("도서를 직접 찾아 비교", { exact: true }).click();
  const picker = page.locator(".book-picker select[name=bookId]");
  await expect(picker).toHaveValue(f.books[1].id);
  await expect(picker.locator("option")).toHaveCount(2);
  await expect(page.locator(".book-picker-pages summary")).toHaveCount(0);
  await page
    .getByPlaceholder("제목·저자·ISBN으로 전체 서재 검색")
    .fill("세번째");
  await expect(picker).toHaveValue(f.books[2].id);
  await page
    .getByLabel("확인한 근거", { exact: true })
    .fill("판권면을 확인한 서로 다른 판본");
  await page.getByRole("button", { name: "연결", exact: true }).click();
  await expect.poll(() => f.calls.filter((c) => c.rightId).length).toBe(1);
  expect(f.calls.find((c) => c.rightId)).toMatchObject({
    leftId: f.books[0].id,
    rightId: f.books[2].id,
    rightVersion: 3,
    state: "accepted",
  });
  await expect(
    page.getByText("서로 다른 도서를 선택해 주세요.", { exact: true }),
  ).toHaveCount(0);
});
test("relation state starts fresh when a different source book is opened", async ({
  page,
}) => {
  const f = await mount(page);
  await page.getByText("다른 소장본·판본 연결", { exact: true }).click();
  await page.getByText("도서를 직접 찾아 비교", { exact: true }).click();
  await expect(page.locator(".book-picker select[name=bookId]")).toHaveValue(
    f.books[1].id,
  );
  await page.evaluate(() => {
    (window as any).sourceIndex = 1;
    (window as any).render();
  });
  const section = page.locator("details.curation-details");
  await expect(section).not.toHaveAttribute("open", "");
  await page.getByText("다른 소장본·판본 연결", { exact: true }).click();
  await page.getByText("도서를 직접 찾아 비교", { exact: true }).click();
  await expect(
    page.locator(".book-picker select[name=bookId]"),
  ).not.toHaveValue(f.books[1].id);
  await expect(
    page.locator(".book-picker option").filter({ hasText: "두번째 판본" }),
  ).toHaveCount(0);
});
test("search opens book tab first and remembers the last chosen tab", async ({
  page,
}) => {
  await mount(page, "search");
  await expect(
    page.getByRole("tab", { name: "도서 검색", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "메모 검색", exact: true }).click();
  await page.evaluate(() => (window as any).render());
  await expect(
    page.getByRole("tab", { name: "메모 검색", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("자료 검색어", { exact: true })).toHaveCount(0);
  await expect(page.getByText("검색 대상", { exact: true })).toHaveCount(0);
});

test("memo search combines searchable topic and tag, suggested book title and content", async ({
  page,
}) => {
  const f = await mount(page, "search");
  await page.getByRole("tab", { name: "메모 검색", exact: true }).click();
  await page
    .getByRole("combobox", { name: "종류", exact: true })
    .selectOption("thought");
  await page
    .getByRole("combobox", { name: "분야", exact: true })
    .selectOption("100");
  await page.getByRole("button", { name: "주제 선택", exact: true }).click();
  await page
    .getByRole("textbox", { name: "주제 검색", exact: true })
    .fill("관계");
  await page.getByRole("option", { name: "관계", exact: true }).click();
  await page.getByRole("button", { name: "태그 선택", exact: true }).click();
  await page
    .getByRole("textbox", { name: "태그 검색", exact: true })
    .fill("공감");
  await page.getByRole("option", { name: "공감", exact: true }).click();
  await page
    .getByRole("combobox", { name: "제목", exact: true })
    .fill("두번째");
  await expect(
    page.locator("datalist option").filter({ hasText: "두번째 판본" }),
  ).toHaveCount(1);
  await page
    .getByRole("textbox", { name: "메모 내용", exact: true })
    .fill("경계");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect
    .poll(() => f.calls.filter((c) => c.searchQuery).length)
    .toBeGreaterThan(0);
  expect(f.calls.find((c) => c.searchQuery).searchQuery).toMatchObject({
    kind: "thought",
    category: "100",
    topic: f.topic,
    tag: "공감",
    bookTitle: "두번째",
    content: "경계",
  });
  const fields = await page
    .locator(".memo-search-fields > label")
    .evaluateAll((es) => es.map((e) => e.firstChild?.textContent?.trim()));
  expect(fields).toEqual(["종류", "분야", "주제", "태그", "제목", "메모 내용"]);
});
for (const width of [390, 1280])
  test(`catalog search and book detail header fit at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const f = await mount(page, "app");
    await expect(page.locator(".topbar input")).toHaveCount(0);
    await page.getByRole("button", { name: "메뉴 열기", exact: true }).click();
    await page.getByRole("button", { name: /^소장 도서/ }).click();
    await page
      .getByRole("searchbox", { name: "소장 도서 검색", exact: true })
      .fill("출판사1");
    await expect(page.locator(".shelf-card")).toHaveCount(1);
    await expect(page.locator(".shelf-card")).toContainText("두번째 판본");
    await expect(page.locator(".notes-grid")).toHaveCount(0);
    await page.locator(".shelf-card").click();
    const dialog = page.getByRole("dialog", {
      name: "책을 펼쳐 보기",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    expect(
      await dialog
        .locator(":scope > header")
        .evaluate((e) => getComputedStyle(e).position),
    ).toBe("static");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await page.screenshot({
      path: `test-results/search-tabs/book-detail-${width}.png`,
      fullPage: false,
    });
  });

test("integrated search moves the old top search into the third tab", async ({
  page,
}) => {
  const f = await mount(page, "search");
  await page.getByRole("tab", { name: "통합 검색", exact: true }).click();
  await page
    .getByRole("searchbox", { name: "통합 검색어", exact: true })
    .fill("저자1");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect.poll(() => f.calls.filter((c) => c.searchQuery).length).toBe(1);
  expect(f.calls.find((c) => c.searchQuery).searchQuery).toMatchObject({
    text: "저자1",
    layer: "all",
  });
  await page.evaluate(() => (window as any).render());
  await expect(
    page.getByRole("tab", { name: "통합 검색", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("검색 대상", { exact: true })).toHaveCount(0);
});

for (const width of [390, 1280])
  test(`memo filters and integrated search fit at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await mount(page, "search");
    await page.getByRole("tab", { name: "메모 검색", exact: true }).click();
    await expect(
      page.getByRole("combobox", { name: "제목", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await page.screenshot({
      path: `test-results/search-tabs/memo-search-${width}.png`,
      fullPage: false,
    });
    await page.getByRole("tab", { name: "통합 검색", exact: true }).click();
    await expect(
      page.getByRole("searchbox", { name: "통합 검색어", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
  });

test("candidate to direct-search transition always connects the displayed target", async ({
  page,
}) => {
  const f = await mount(page, "relations", true);
  await page.getByText("다른 소장본·판본 연결", { exact: true }).click();
  await page
    .getByRole("button", { name: "같은 ISBN 후보 확인", exact: true })
    .click();
  await page.getByText("도서를 직접 찾아 비교", { exact: true }).click();
  const picker = page.locator(".book-picker select[name=bookId]");
  await expect(picker).toHaveValue(f.books[1].id);
  await page
    .getByRole("button", { name: "같은 ISBN 후보 확인", exact: true })
    .click();
  const direct = page
    .getByText("도서를 직접 찾아 비교", { exact: true })
    .locator("..");
  await expect(direct).not.toHaveAttribute("open", "");
  await page.getByText("도서를 직접 찾아 비교", { exact: true }).click();
  await expect(picker).toHaveValue(f.books[1].id);
  await picker.selectOption(f.books[1].id);
  await page
    .getByLabel("확인한 근거", { exact: true })
    .fill("선택한 두번째 판본을 확인");
  await page.getByRole("button", { name: "연결", exact: true }).click();
  await expect.poll(() => f.calls.filter((c) => c.rightId).length).toBe(1);
  expect(f.calls.find((c) => c.rightId).rightId).toBe(f.books[1].id);
});
