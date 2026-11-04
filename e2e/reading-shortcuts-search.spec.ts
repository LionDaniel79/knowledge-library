import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { previewLibrary } from "../src/lib/preview-data";
let bundle: string;
test.beforeAll(async () => {
  bundle = (
    await build({
      stdin: {
        contents: `import{createRoot}from'react-dom/client';import{LibraryApp}from'./src/components/library-app';createRoot(document.getElementById('root')).render(<LibraryApp initial={window.fixture} today="2026-10-25" ownerId="restoration-test"/>);`,
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
async function mount(page: Page, remote = true) {
  const book = {
    ...previewLibrary.books[0],
    id: crypto.randomUUID(),
    title: "공감의 책",
    author: "서재 저자",
    publisher: "지식 출판",
    storedCoverUrl: "/api/book-covers/" + crypto.randomUUID(),
  };
  let notes = [0, 1].map((i) => ({
    ...previewLibrary.notes[0],
    id: crypto.randomUUID(),
    bookId: i ? null : book.id,
    title: i ? "책 밖의 공감" : "공감과 경계",
    content: i ? "공감은 이해에서 시작한다" : "공감하면서 경계를 지킨다",
    tags: ["공감"],
    kind: "thought" as const,
  }));
  const calls: any[] = [];
  let deleted = false;
  const fixture = {
    ...previewLibrary,
    books: [book],
    notes: remote ? [] : notes,
    cycles: [],
    ...(remote
      ? {
          catalog: {
            total: 80,
            formatCounts: { paper: 80, pdf: 0, ebook: 0, unknown: 0 },
            categoryCounts: {},
            firstPage: { items: [book], total: 80 },
          },
        }
      : {}),
  };
  await page.route("https://library.test/api/**", async (r) => {
    const u = new URL(r.request().url()),
      q = (u.searchParams.get("q") ?? "").toLowerCase();
    if (u.pathname.startsWith("/api/book-covers/"))
      return r.fulfill({
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
          "base64",
        ),
      });
    if (u.pathname === "/api/books") {
      calls.push({
        kind: "books",
        q,
        params: Object.fromEntries(u.searchParams),
      });
      const items = [book].filter(
        (b) =>
          !q ||
          [b.title, b.author, b.publisher].some((t) =>
            t.toLowerCase().includes(q),
          ),
      );
      return r.fulfill({ json: { items, total: items.length } });
    }
    if (u.pathname === "/api/notes") {
      calls.push({
        kind: "notes",
        q,
        params: Object.fromEntries(u.searchParams),
      });
      const items = notes.filter(
        (n) =>
          !q ||
          [n.title, n.content, ...n.tags, n.bookId ? book.title : ""]
            .join(" ")
            .toLowerCase()
            .includes(q),
      );
      return r.fulfill({ json: { items, total: items.length } });
    }
    if (u.pathname.startsWith("/api/notes/"))
      return r.fulfill({
        json: notes.find((n) => n.id === u.pathname.split("/").at(-1)),
      });
    if (u.pathname === "/api/library")
      return r.fulfill({ json: { ...fixture, notes: remote ? [] : notes } });
    if (u.pathname === "/api/note-tags") {
      if (r.request().method() === "POST") {
        calls.push({ tagDelete: r.request().postDataJSON() });
        deleted = true;
        notes = notes.map((n) => ({ ...n, tags: [] }));
        return r.fulfill({ json: { ok: true } });
      }
      return r.fulfill({
        json: deleted
          ? []
          : [
              {
                tag: "공감",
                count: 2,
                activeCount: 2,
                fingerprint: "a".repeat(64),
              },
            ],
      });
    }
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
    if (u.pathname === "/api/library-search")
      return r.fulfill({ json: { items: [], total: 0 } });
    if (u.pathname === "/api/library-search/topics")
      return r.fulfill({ json: { topics: [] } });
    if (u.pathname.startsWith("/api/books/")) return r.fulfill({ json: book });
    return r.fulfill({
      json: {
        items: [],
        documents: [],
        hits: [],
        total: 0,
        topics: [],
        memberships: [],
        topicLinks: [],
        roots: [],
        connections: [],
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
  await page.evaluate((f) => ((window as any).fixture = f), fixture);
  await page.addStyleTag({ path: "src/app/globals.css" });
  await page.addScriptTag({ content: bundle });
  return { book, notes, calls };
}
async function navigate(page: Page, name: string | RegExp) {
  await page.getByRole("button", { name: "메뉴 열기", exact: true }).click();
  await page
    .getByRole("button", { name, exact: typeof name === "string" })
    .click();
}
for (const width of [390, 1280])
  test(`new record remains available on every screen at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await mount(page, false);
    for (const screen of [
      "나의 서재",
      /^소장 도서/,
      "통합 검색",
      "사유의 지도",
      "독서 달력",
      "독서 통계",
    ]) {
      await navigate(page, screen);
      const button = page
        .locator(".topbar")
        .getByRole("button", { name: "새 기록", exact: true });
      await expect(button).toBeVisible();
      await button.click();
      const dialog = page.getByRole("dialog", {
        name: "새로운 기록",
        exact: true,
      });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByLabel("내용", { exact: true })).toBeVisible();
      await dialog.getByRole("button", { name: "닫기", exact: true }).click();
    }
  });
for (const remote of [true, false])
  test(`integrated search restores live book covers and both linked/free notes (remote=${remote})`, async ({
    page,
  }) => {
    const f = await mount(page, remote);
    await navigate(page, "통합 검색");
    await page.getByRole("tab", { name: "통합 검색", exact: true }).click();
    await page
      .getByRole("searchbox", { name: "통합 검색어", exact: true })
      .fill("공감");
    await expect(page.locator(".integrated-search .shelf-card")).toHaveCount(1);
    await expect(
      page.locator(".integrated-search .shelf-card .book-cover img"),
    ).toHaveCount(1);
    await expect(page.locator(".integrated-search .note-card")).toHaveCount(2);
    await expect(
      page.getByRole("button", { name: "책 밖의 공감", exact: true }),
    ).toBeVisible();
    if (remote) {
      expect(f.calls.some((c) => c.kind === "books" && c.q === "공감")).toBe(
        true,
      );
      expect(f.calls.some((c) => c.kind === "notes" && c.q === "공감")).toBe(
        true,
      );
    }
    await page.locator(".integrated-search .shelf-card").click();
    await expect(
      page.getByRole("dialog", { name: "책을 펼쳐 보기", exact: true }),
    ).toContainText(f.book.title);
    await page
      .getByRole("dialog", { name: "책을 펼쳐 보기", exact: true })
      .getByRole("button", { name: "닫기", exact: true })
      .click();
    await page
      .getByRole("button", { name: "책 밖의 공감", exact: true })
      .click();
    await expect(
      page.getByRole("dialog", { name: "기록 수정", exact: true }),
    ).toBeVisible();
  });
test("memo search keeps tag searching and deletes a tag through the shared bulk command", async ({
  page,
}) => {
  const f = await mount(page);
  await navigate(page, "통합 검색");
  await page.getByRole("tab", { name: "메모 검색", exact: true }).click();
  await page.getByRole("button", { name: "태그 선택", exact: true }).click();
  await page
    .getByRole("searchbox", { name: "태그 검색", exact: true })
    .fill("공감");
  await page.getByRole("button", { name: "공감", exact: true }).click();
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect
    .poll(() => f.calls.filter((c) => c.kind === "notes").at(-1)?.params.tag)
    .toBe("공감");
  await page.getByRole("button", { name: "태그 선택", exact: true }).click();
  await page
    .getByRole("button", { name: "태그 삭제 공감", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "태그 삭제 확인", exact: true })
    .getByRole("button", { name: "태그 삭제", exact: true })
    .click();
  await expect.poll(() => f.calls.filter((c) => c.tagDelete).length).toBe(1);
  expect(f.calls.find((c) => c.tagDelete).tagDelete).toMatchObject({
    tag: "공감",
    fingerprint: "a".repeat(64),
  });
  await expect(
    page.getByRole("button", { name: "태그 삭제 공감", exact: true }),
  ).toHaveCount(0);
  await expect
    .poll(() => f.calls.filter((c) => c.kind === "notes").at(-1)?.params.tag)
    .toBe("all");
});
test("thought-map refresh controls are removed while notes still load", async ({
  page,
}) => {
  await mount(page, false);
  await navigate(page, "사유의 지도");
  await expect(page.locator(".thought-card")).toHaveCount(2);
  await expect(
    page
      .locator(".knowledge-tabs")
      .getByRole("button", { name: "새로고침", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "지도 새로고침", exact: true }),
  ).toHaveCount(0);
});

test("restored result cards and tag management fit the phone width", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mount(page);
  await navigate(page, "통합 검색");
  await page.getByRole("tab", { name: "통합 검색", exact: true }).click();
  await page
    .getByRole("searchbox", { name: "통합 검색어", exact: true })
    .fill("공감");
  await expect(page.locator(".integrated-search .note-card")).toHaveCount(2);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: "test-results/reading-shortcuts/restored-search-mobile.png",
    fullPage: true,
  });
  await page.getByRole("tab", { name: "메모 검색", exact: true }).click();
  await page.getByRole("button", { name: "태그 선택", exact: true }).click();
  const search = page.getByRole("searchbox", {
    name: "태그 검색",
    exact: true,
  });
  await expect(search).toBeVisible();
  await expect(search).not.toBeFocused();
  await expect(
    page.getByRole("button", { name: "태그 삭제 공감", exact: true }),
  ).toBeVisible();
  const box = (await page.locator(".tag-dropdown").boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: "test-results/reading-shortcuts/tags-mobile.png",
    fullPage: false,
  });
});
