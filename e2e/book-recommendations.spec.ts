import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { previewLibrary } from "../src/lib/preview-data";

const books = ["종이 첫 책", "종이 다음 책", "PDF 책", "로고스 책"].map(
  (title, i) => ({
    ...previewLibrary.books[0],
    id: `recommended-${i}`,
    title,
    author: "추천 저자",
    formats: [i < 2 ? "paper" : i === 2 ? "pdf" : "logos"],
  }),
);
const saved = {
  recommendations: books.map((book, i) => ({
    bookId: book.id,
    format: i < 2 ? "paper" : i === 2 ? "pdf" : "logos",
    reason: `${book.title} 추천 이유`,
  })),
  books,
  updatedAt: "2026-11-12T00:00:00.000Z",
};
let bundle: string;
test.beforeAll(async () => {
  bundle = (
    await build({
      stdin: {
        contents: `import {createRoot} from 'react-dom/client';import {BookRecommendations} from './src/components/book-recommendations';import {LibraryApp} from './src/components/library-app';const root=createRoot(document.getElementById('root'));window.renderRecommendations=(owner,revision,excludedBookIds=[])=>root.render(<BookRecommendations ownerId={owner} revision={revision} excludedBookIds={excludedBookIds} onOpenBook={id => document.getElementById('opened').textContent = id}/>);if(window.app)root.render(<LibraryApp initial={window.fixture} today="2026-11-12" ownerId="owner-a" preview/>);else window.renderRecommendations(window.owner ?? "owner-a",0);`,
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
async function mount(page: Page, owner = "owner-a", app = false) {
  await page.route("https://library.test/", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><div id="opened"></div>',
    }),
  );
  await page.goto("https://library.test/");
  await page.evaluate(
    ({ owner, app, books }) => {
      Object.assign(window, {
        owner,
        app,
        fixture: { books, cycles: [], notes: [], shelves: [] },
      });
    },
    { owner, app, books },
  );
  await page.addStyleTag({ path: "src/app/globals.css" });
  await page.addScriptTag({ content: bundle });
}
test("saved recommendations use tabs, arrows, keyboard and swipe without requesting AI", async ({
  page,
}) => {
  const methods: string[] = [];
  await page.route("**/api/book-recommendations", (r) => {
    methods.push(r.request().method());
    return r.fulfill({ json: saved });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await mount(page);
  const region = page.getByRole("region", { name: "AI가 추천하는 나의 책" });
  await expect(
    region.getByRole("button", { name: "종이 첫 책 상세 보기" }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/book-recommendations/mobile.png",
    fullPage: true,
  });
  await region.getByRole("button", { name: "다음 추천 책" }).click();
  await expect(
    region.getByRole("button", { name: "종이 다음 책 상세 보기" }),
  ).toBeVisible();
  const carousel = region.getByRole("group", { name: "추천 책 넘기기" });
  const box = await carousel.boundingBox();
  if (!box) throw Error("Missing carousel");
  await page.mouse.move(box.x + 40, box.y + 60);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 40, box.y + 60, { steps: 5 });
  await page.mouse.up();
  await expect(
    region.getByRole("button", { name: "종이 첫 책 상세 보기" }),
  ).toBeVisible();
  await region.getByRole("group", { name: "추천 책 넘기기" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    region.getByRole("button", { name: "종이 다음 책 상세 보기" }),
  ).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await region.getByRole("button", { name: "종이 첫 책 상세 보기" }).click();
  await expect(page.locator("#opened")).toHaveText("recommended-0");
  await carousel.dispatchEvent("touchstart", {
    touches: [{ identifier: 0, clientX: 260, clientY: 100 }],
  });
  await carousel.dispatchEvent("touchend", {
    changedTouches: [{ identifier: 0, clientX: 80, clientY: 105 }],
  });
  await expect(
    region.getByRole("button", { name: "종이 다음 책 상세 보기" }),
  ).toBeVisible();
  await region.getByRole("tab", { name: "PDF", exact: true }).click();
  await expect(
    region.getByRole("button", { name: "PDF 책 상세 보기" }),
  ).toBeVisible();
  await region.getByRole("tab", { name: "로고스", exact: true }).click();
  await expect(
    region.getByRole("button", { name: "로고스 책 상세 보기" }),
  ).toBeVisible();
  expect(methods).toEqual(["GET"]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
});
test("only explicit click starts AI, immediate pending state prevents duplicate clicks and polls by GET", async ({
  page,
}) => {
  let posts = 0,
    gets = 0,
    requestId = "";
  await page.route("**/api/book-recommendations", async (r) => {
    if (r.request().method() === "POST") {
      posts++;
      requestId = r.request().postDataJSON().requestId;
      await new Promise((resolve) => setTimeout(resolve, 150));
      return r.fulfill({
        status: 202,
        json: {
          recommendations: [],
          books: [],
          updatedAt: null,
          request: { requestId, status: "sending" },
        },
      });
    }
    gets++;
    return r.fulfill({
      json:
        gets > 1 ? saved : { recommendations: [], books: [], updatedAt: null },
    });
  });
  await mount(page);
  const button = page.getByRole("button", { name: "추천받기", exact: true });
  await expect(button).toBeEnabled();
  expect(posts).toBe(0);
  await button.click();
  await expect(page.getByRole("button", { name: "추천 중…" })).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "새로고침", exact: true }),
  ).toBeEnabled({ timeout: 7000 });
  expect(posts).toBe(1);
  expect(requestId).toMatch(/^[\da-f-]{36}$/i);
});
test("confirmed owner cache survives failed refresh and offline reopen without automatic POST", async ({
  page,
}) => {
  let fail = false;
  const ids: string[] = [];
  await page.route("**/api/book-recommendations", (r) => {
    if (r.request().method() === "POST") {
      ids.push(r.request().postDataJSON().requestId);
      return r.abort();
    }
    return fail ? r.abort() : r.fulfill({ json: saved });
  });
  await mount(page);
  await expect(
    page.getByRole("button", { name: "종이 첫 책 상세 보기" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "새로고침", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "종이 첫 책 상세 보기" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "새로고침", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  expect(ids).toHaveLength(2);
  expect(ids[1]).toBe(ids[0]);
  fail = true;
  await mount(page);
  await expect(
    page.getByRole("button", { name: "종이 첫 책 상세 보기" }),
  ).toBeVisible();
  expect(ids).toHaveLength(2);
  await mount(page, "owner-b");
  await expect(
    page.getByRole("button", { name: "종이 첫 책 상세 보기" }),
  ).toHaveCount(0);
});

for (const status of [undefined, "succeeded"] as const) {
  test(`authoritative empty saved result clears stale owner cache (${status ?? "normal"}) without generation`, async ({
    page,
  }) => {
    await page.addInitScript(
      (value) =>
        localStorage.setItem(
          "library:book-recommendations:v1:owner-a",
          JSON.stringify(value),
        ),
      saved,
    );
    const methods: string[] = [];
    await page.route("**/api/book-recommendations", (r) => {
      methods.push(r.request().method());
      return r.fulfill({
        json: {
          recommendations: [],
          books: [],
          updatedAt: null,
          ...(status
            ? {
                request: {
                  requestId: "00000000-0000-4000-8000-000000000001",
                  status,
                },
              }
            : {}),
        },
      });
    });
    await mount(page);
    await expect(
      page.getByRole("button", { name: "추천받기", exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "종이 첫 책 상세 보기" }),
    ).toHaveCount(0);
    const cached = await page.evaluate(() =>
      JSON.parse(
        localStorage.getItem("library:book-recommendations:v1:owner-a")!,
      ),
    );
    expect(cached.recommendations).toEqual([]);
    expect(cached.books).toEqual([]);
    expect(methods).toEqual(["GET"]);
  });
}

test("preview needs login and does not request or generate recommendations", async ({
  page,
}) => {
  const methods: string[] = [];
  await page.route("**/api/book-recommendations", (r) => {
    methods.push(r.request().method());
    return r.fulfill({ json: saved });
  });
  await mount(page, "");
  await expect(
    page.getByText("로그인하면 내 소장 도서에서 추천을 받을 수 있어요."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "추천받기", exact: true }),
  ).toBeDisabled();
  expect(methods).toEqual([]);
});

test("library revisions recheck only saved recommendations and remove ineligible books", async ({
  page,
}) => {
  const methods: string[] = [];
  await page.route("**/api/book-recommendations", (r) => {
    methods.push(r.request().method());
    return r.fulfill({
      json:
        methods.length === 1
          ? saved
          : {
              ...saved,
              recommendations: saved.recommendations.slice(1),
              books: books.slice(1),
            },
    });
  });
  await mount(page);
  await expect(
    page.getByRole("button", { name: "종이 첫 책 상세 보기" }),
  ).toBeVisible();
  await page.evaluate(() =>
    (window as any).renderRecommendations("owner-a", 1),
  );
  await expect(
    page.getByRole("button", { name: "종이 다음 책 상세 보기" }),
  ).toBeVisible();
  expect(methods).toEqual(["GET", "GET"]);
});

test("home recommendations open existing book detail while calendar menu remains available", async ({
  page,
}) => {
  await page.route("**/api/book-recommendations", (r) =>
    r.fulfill({ json: saved }),
  );
  await mount(page, "owner-a", true);
  await page.getByRole("button", { name: "종이 첫 책 상세 보기" }).click();
  await expect(page.getByRole("dialog")).toContainText("종이 첫 책");
  await page.getByRole("button", { name: "닫기", exact: true }).last().click();
  await page.getByRole("button", { name: "메뉴 열기", exact: true }).click();
  await page.getByRole("button", { name: "독서 달력", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "책으로 채운 달력" }),
  ).toBeVisible();
});

test("terminal unknown preserves saved recommendations and a new explicit click gets a new UUID", async ({
  page,
}) => {
  const ids: string[] = [];
  await page.route("**/api/book-recommendations", (r) => {
    if (r.request().method() === "GET") return r.fulfill({ json: saved });
    const requestId = r.request().postDataJSON().requestId;
    ids.push(requestId);
    return r.fulfill({
      json: { ...saved, request: { requestId, status: "unknown" } },
    });
  });
  await mount(page);
  const refresh = page.getByRole("button", { name: "새로고침", exact: true });
  await refresh.click();
  await expect(page.getByRole("alert")).toContainText("예약 금액");
  await expect(
    page.getByRole("button", { name: "종이 첫 책 상세 보기" }),
  ).toBeVisible();
  await refresh.click();
  await expect(page.getByRole("alert")).toContainText("예약 금액");
  expect(ids).toHaveLength(2);
  expect(ids[1]).not.toBe(ids[0]);
});

test("pending request recovers with the same UUID after a status-read connection failure", async ({
  page,
}) => {
  const ids: string[] = [];
  let gets = 0;
  await page.route("**/api/book-recommendations", (r) => {
    if (r.request().method() === "POST") {
      const requestId = r.request().postDataJSON().requestId;
      ids.push(requestId);
      return r.fulfill({
        status: 202,
        json: { ...saved, request: { requestId, status: "sending" } },
      });
    }
    gets++;
    return gets === 2 ? r.abort() : r.fulfill({ json: saved });
  });
  await mount(page);
  await page.getByRole("button", { name: "새로고침", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible({ timeout: 7000 });
  await page.getByRole("button", { name: "새로고침", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "새로고침", exact: true }),
  ).toBeEnabled({ timeout: 7000 });
  expect(ids).toHaveLength(2);
  expect(ids[1]).toBe(ids[0]);
});

for (const status of ["sending", "failed", "unknown"] as const) {
  test(`empty ${status} response preserves the confirmed owner cache`, async ({
    page,
  }) => {
    await page.addInitScript(
      (value) =>
        localStorage.setItem(
          "library:book-recommendations:v1:owner-a",
          JSON.stringify(value),
        ),
      saved,
    );
    const methods: string[] = [];
    await page.route("**/api/book-recommendations", (r) => {
      methods.push(r.request().method());
      return r.fulfill({
        json: {
          recommendations: [],
          books: [],
          updatedAt: null,
          request: {
            requestId: "00000000-0000-4000-8000-000000000001",
            status,
          },
        },
      });
    });
    await mount(page);
    if (status === "sending")
      await expect(
        page.getByRole("button", { name: "추천 중…" }),
      ).toBeDisabled();
    else await expect(page.getByRole("alert")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "종이 첫 책 상세 보기" }),
    ).toBeVisible();
    const cached = await page.evaluate(() =>
      JSON.parse(
        localStorage.getItem("library:book-recommendations:v1:owner-a")!,
      ),
    );
    expect(cached).toEqual(saved);
    expect(methods).toEqual(["GET"]);
  });
}

for (const status of ["failed", "unknown"] as const) {
  test(`fresh device displays the last successful snapshot even when latest request ${status}`, async ({
    page,
  }) => {
    const methods: string[] = [];
    await page.route("**/api/book-recommendations", (r) => {
      methods.push(r.request().method());
      return r.fulfill({
        json: {
          ...saved,
          request: {
            requestId: "00000000-0000-4000-8000-000000000001",
            status,
          },
        },
      });
    });
    await mount(page);
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "종이 첫 책 상세 보기" }),
    ).toBeVisible();
    const cached = await page.evaluate(() =>
      JSON.parse(
        localStorage.getItem("library:book-recommendations:v1:owner-a")!,
      ),
    );
    expect(cached).toEqual(saved);
    expect(methods).toEqual(["GET"]);
  });
}

test("failed latest request still applies canonical filtering of read or deleted recommendations", async ({
  page,
}) => {
  await page.addInitScript(
    (value) =>
      localStorage.setItem(
        "library:book-recommendations:v1:owner-a",
        JSON.stringify(value),
      ),
    saved,
  );
  const methods: string[] = [];
  await page.route("**/api/book-recommendations", (r) => {
    methods.push(r.request().method());
    return r.fulfill({
      json: {
        recommendations: [],
        books: [],
        updatedAt: saved.updatedAt,
        request: {
          requestId: "00000000-0000-4000-8000-000000000001",
          status: "failed",
        },
      },
    });
  });
  await mount(page);
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "종이 첫 책 상세 보기" }),
  ).toHaveCount(0);
  await expect(page.getByText("이 형식의 추천 책이 없습니다.")).toBeVisible();
  const cached = await page.evaluate(() =>
    JSON.parse(
      localStorage.getItem("library:book-recommendations:v1:owner-a")!,
    ),
  );
  expect(cached.recommendations).toEqual([]);
  expect(cached.updatedAt).toBe(saved.updatedAt);
  expect(methods).toEqual(["GET"]);
});

test("local completed and reading IDs hide stale cached/server recommendations immediately without paid refresh", async ({
  page,
}) => {
  let posts = 0;
  await page.route("https://library.test/api/book-recommendations", (route) => {
    if (route.request().method() === "POST") posts++;
    return route.fulfill({ json: saved });
  });
  await mount(page);
  await expect(
    page.getByRole("button", { name: "종이 첫 책 상세 보기" }),
  ).toBeVisible();
  await page.evaluate(() =>
    (window as any).renderRecommendations("owner-a", 0, [
      "recommended-0",
      "recommended-1",
    ]),
  );
  await expect(
    page.getByRole("button", { name: "종이 첫 책 상세 보기" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "종이 다음 책 상세 보기" }),
  ).toHaveCount(0);
  await page.evaluate(() =>
    (window as any).renderRecommendations("owner-a", 1, [
      "recommended-0",
      "recommended-1",
    ]),
  );
  await expect(
    page.getByRole("button", { name: "종이 첫 책 상세 보기" }),
  ).toHaveCount(0);
  expect(posts).toBe(0);
});
