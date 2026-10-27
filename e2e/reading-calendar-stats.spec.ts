import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { randomUUID } from "node:crypto";
import { previewLibrary } from "../src/lib/preview-data";
let bundle: string;
test.beforeAll(async () => {
  bundle = (
    await build({
      stdin: {
        contents: `import{createRoot}from'react-dom/client';import{LibraryApp}from'./src/components/library-app';createRoot(document.getElementById('root')).render(<LibraryApp initial={window.fixture} today="2026-10-28" ownerId="reading-controls-test"/>);`,
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
async function mount(page: Page, remote = false) {
  const books = ["처음 읽은 책", "다음 읽은 책"].map((title) => ({
    ...previewLibrary.books[0],
    id: randomUUID(),
    title,
    storedCoverUrl: "/api/book-covers/" + randomUUID(),
  }));
  const cycles = [
    { day: "2026-10-22", book: 1 },
    { day: "2026-10-02", book: 0 },
    { day: "2026-10-10", book: 0 },
    { day: "2026-09-30", book: 1 },
    { day: null, book: 0 },
    { day: "2026-10-05", book: 1, status: "reading" },
  ].map((c) => ({
    ...previewLibrary.cycles[0],
    id: randomUUID(),
    bookId: books[c.book].id,
    status: c.status ?? "completed",
    completedOn: c.day,
    version: 1,
  }));
  const expected = [cycles[1], cycles[2], cycles[0]];
  const fixture = {
    ...previewLibrary,
    books,
    notes: [],
    cycles: remote ? [] : cycles,
    ...(remote
      ? {
          readingSummary: {
            totalCompleted: 5,
            undatedCount: 1,
            completedIds: books.map((b) => b.id),
            months: {
              "2026-10": { monthCount: 3, uniqueBooks: 2, rereads: 1 },
              "2026-09": { monthCount: 1, uniqueBooks: 1, rereads: 0 },
            },
          },
        }
      : {}),
  };
  const calls: string[] = [];
  await page.route("**/*", async (route) => {
    const u = new URL(route.request().url());
    if (u.hostname !== "library.test") return route.abort();
    if (u.pathname === "/")
      return route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>',
      });
    if (u.pathname.startsWith("/api/book-covers/"))
      return route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="164"><rect width="120" height="164" fill="#d7e4d1"/><text x="12" y="42" fill="#244c3d" font-size="15">READING</text><text x="12" y="65" fill="#244c3d" font-size="15">BOOK</text></svg>',
      });
    if (u.pathname === "/api/reading") {
      calls.push(u.search);
      if (u.searchParams.has("completedMonth")) {
        const rows = expected.filter((c) =>
          c.completedOn!.startsWith(u.searchParams.get("completedMonth")!),
        );
        const offset = Number(u.searchParams.get("offset") ?? 0),
          limit = Number(u.searchParams.get("limit") ?? 30);
        return route.fulfill({
          json: {
            items: rows.slice(offset, offset + limit),
            total: rows.length,
            books,
          },
        });
      }
      if (u.searchParams.has("month"))
        return route.fulfill({
          json: { days: expected.map((c) => ({ ...c, total: 1 })), books },
        });
      const items = expected.filter(
        (c) => c.completedOn === u.searchParams.get("date"),
      );
      return route.fulfill({ json: { items, total: items.length, books } });
    }
    if (u.pathname === "/api/library") return route.fulfill({ json: fixture });
    if (u.pathname.startsWith("/api/books/"))
      return route.fulfill({
        json: books.find((b) => b.id === u.pathname.split("/").at(-1)),
      });
    return route.fulfill({
      json: { items: [], total: 0, topics: [], connections: [] },
    });
  });
  await page.goto("https://library.test/");
  await page.evaluate((f) => {
    (window as any).fixture = f;
  }, fixture);
  await page.addStyleTag({ path: "src/app/globals.css" });
  await page.addScriptTag({ content: bundle });
  return { books, expected, calls };
}
async function navigate(page: Page, name: string) {
  await page.getByRole("button", { name: "메뉴 열기", exact: true }).click();
  await page.getByRole("button", { name, exact: true }).click();
}
test("calendar header jumps to a chosen date and today on home and calendar screens", async ({
  page,
}, testInfo) => {
  await mount(page);
  for (const screen of ["나의 서재", "독서 달력"]) {
    if (screen !== "나의 서재") await navigate(page, screen);
    const calendar = page.locator(".calendar-panel");
    await expect(
      calendar.getByRole("button", { name: "날짜 이동", exact: true }),
    ).toBeVisible();
    await calendar
      .getByRole("button", { name: "날짜 이동", exact: true })
      .click();
    await calendar
      .getByLabel("이동할 날짜", { exact: true })
      .fill("2018-02-03");
    await calendar.getByRole("button", { name: "이동", exact: true }).click();
    await expect(calendar.locator(".month-selector")).toContainText(
      "2018년 2월",
    );
    await expect(
      calendar.getByRole("button", { name: "2018-02-03", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await calendar
      .getByRole("button", { name: "날짜 이동", exact: true })
      .click();
    await page.screenshot({ path: testInfo.outputPath("date-jump.png") });
    await calendar.getByRole("button", { name: "오늘", exact: true }).click();
    await expect(
      calendar.getByRole("button", { name: "2026-10-28", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(calendar.locator(".month-selector")).toContainText(
      "2026년 10월",
    );
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const calendar = page.locator(".calendar-panel");
  await calendar
    .getByRole("button", { name: "날짜 이동", exact: true })
    .click();
  await calendar.getByLabel("이동할 날짜", { exact: true }).fill("2018-02-03");
  await calendar.getByRole("button", { name: "이동", exact: true }).click();
  await navigate(page, "독서 통계");
  await expect(
    page.getByRole("combobox", { name: "통계 연도", exact: true }),
  ).toHaveValue("2018");
});
for (const remote of [false, true]) {
  test(`monthly bars show chronological clickable covers including rereads (remote=${remote})`, async ({
    page,
  }, testInfo) => {
    const f = await mount(page, remote);
    await navigate(page, "독서 통계");
    await page
      .getByRole("button", { name: "2026-10 완독 3권", exact: true })
      .click();
    const list = page.locator(".month-completed-books");
    await expect(list.locator("[data-cycle-id]")).toHaveCount(3);
    expect(
      await list
        .locator("[data-cycle-id]")
        .evaluateAll((els) =>
          els.map((el) => el.getAttribute("data-cycle-id")),
        ),
    ).toEqual(f.expected.map((c) => c.id));
    await expect(list.locator("img")).toHaveCount(3);
    await expect(page.getByText(/같은 책을 두 번 읽으면/)).toHaveCount(0);
    await list
      .getByRole("button", {
        name: "처음 읽은 책 · 2026-10-02 완독",
        exact: true,
      })
      .click();
    const detail = page.getByRole("dialog", {
      name: "책을 펼쳐 보기",
      exact: true,
    });
    await expect(detail).toContainText("처음 읽은 책");
    await detail.getByRole("button", { name: "닫기", exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath("monthly-covers.png") });
    await page
      .getByRole("button", { name: "2026-11 완독 0권", exact: true })
      .click();
    await expect(list.locator("[data-cycle-id]")).toHaveCount(0);
    await expect(list).toContainText("이달의 완독 기록이 없습니다.");
    if (remote)
      expect(f.calls.some((q) => q.includes("completedMonth=2026-10"))).toBe(
        true,
      );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}
