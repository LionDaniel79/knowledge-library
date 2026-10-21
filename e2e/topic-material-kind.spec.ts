import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";

let bundle: string;
test.beforeAll(async () => {
  bundle = (
    await build({
      stdin: {
        contents: `import {createRoot} from 'react-dom/client';import {TopicBrowser} from './src/components/thought-map/topic-browser';createRoot(document.getElementById('root')).render(<div className="thought-panel"><header style={{height:220}}>사유의 지도</header><TopicBrowser {...window.fixture} send={async()=>true} busy={false} onOpen={(kind,id)=>{window.opened={kind,id}}}/></div>);`,
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

async function mount(page: Page) {
  const topics = Array.from({ length: 40 }, (_, i) => ({
    id: crypto.randomUUID(),
    name: `독서 주제 ${i}`,
    confirmed: true,
    aliases: [],
    parentId: null,
    description: "",
    kdcCodes: [],
    version: 1,
  }));
  const notes = Array.from({ length: 18 }, (_, i) => ({
    id: crypto.randomUUID(),
    kind: "note",
    title: `내 생각 ${i + 1}`,
    text: "책을 읽고 내가 남긴 생각",
    category: i < 2 ? "200" : "100",
    version: 1,
  }));
  const books = Array.from({ length: 35 }, (_, i) => ({
    id: crypto.randomUUID(),
    kind: "book",
    title: `소장 책 ${i + 1}`,
    text: "저자 · 출판사",
    category: "100",
    version: 1,
  }));
  const requests: URLSearchParams[] = [];
  await page.route("https://library.test/api/library-materials?*", (r) => {
    const p = new URL(r.request().url()).searchParams;
    requests.push(p);
    const kind = p.get("kind") ?? "all",
      category = p.get("category");
    const items = [...notes, ...books].filter(
      (m) =>
        (kind === "all" || kind === m.kind) &&
        (!category || category === "all" || m.category === category),
    );
    const offset = Number(p.get("offset") ?? 0),
      limit = Number(p.get("limit") ?? 30);
    return r.fulfill({
      json: { total: items.length, items: items.slice(offset, offset + limit) },
    });
  });
  await page.route("https://library.test/", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html lang="ko"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>',
    }),
  );
  await page.goto("https://library.test/");
  await page.evaluate(
    (fixture) => {
      localStorage.setItem("library:page-size:topic-materials", "15");
      (window as any).fixture = fixture;
    },
    {
      library: {
        books: [],
        notes: [],
        cycles: [],
        catalog: { total: books.length },
      },
      state: { topics, memberships: [], topicLinks: [] },
    },
  );
  await page.addStyleTag({ path: "src/app/globals.css" });
  await page.addScriptTag({ content: bundle });
  return { requests };
}

test("topic materials start with my notes and reset the page when switching kind or library field", async ({
  page,
}) => {
  const f = await mount(page);
  await expect(
    page.getByRole("combobox", { name: "자료 종류", exact: true }),
  ).toHaveValue("note");
  await expect(page.locator(".thought-card")).toHaveCount(15);
  await expect(page.locator(".topic-material-count")).toHaveText(
    "내 기록 18개",
  );
  await page.getByRole("button", { name: "2페이지", exact: true }).click();
  await expect(page.locator(".thought-card")).toHaveCount(3);
  await page
    .getByRole("combobox", { name: "도서 분야", exact: true })
    .selectOption("200");
  await expect(page.locator(".thought-card")).toHaveCount(2);
  await expect(page.locator(".topic-material-count")).toHaveText("내 기록 2개");
  await expect(page.locator(".thought-card > small")).toHaveText([
    "내 기록 · 종교",
    "내 기록 · 종교",
  ]);
  await page
    .getByRole("combobox", { name: "도서 분야", exact: true })
    .selectOption("all");
  await page
    .getByRole("combobox", { name: "자료 종류", exact: true })
    .selectOption("book");
  await expect(page.locator(".topic-material-count")).toHaveText("책 35권");
  await expect(page.locator(".thought-card")).toHaveCount(15);
  await expect(page.locator(".thought-card > small").first()).toHaveText(
    "소장 도서 · 철학·심리학",
  );
  expect(f.requests.at(-1)?.get("offset")).toBe("0");
  await page
    .getByRole("combobox", { name: "자료 종류", exact: true })
    .selectOption("all");
  await expect(page.locator(".topic-material-count")).toHaveText(
    "책과 내 기록 53개",
  );
});

for (const width of [390, 1440])
  test(`the material list is reachable below compact filters with 40 topics at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await mount(page);
    await expect(page.locator(".thought-card")).toHaveCount(15);
    const card = (await page.locator(".thought-card").first().boundingBox())!;
    expect(card.y).toBeLessThan(760);
    expect(
      await page.locator("body").evaluate((el) => el.scrollWidth),
    ).toBeLessThanOrEqual(width);
    if (width === 390)
      await page
        .getByRole("button", { name: "주제 관리", exact: true })
        .click();
    await page
      .getByRole("button", { name: "독서 주제 39", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "독서 주제 39", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await page
      .getByRole("combobox", { name: "도서 분야", exact: true })
      .selectOption("200");
    await expect(page.locator(".thought-card")).toHaveCount(2);
    const first = (await page.locator(".thought-card").first().boundingBox())!;
    const filter = (await page
      .locator(".topic-material-filters")
      .boundingBox())!;
    expect(first.y - (filter.y + filter.height)).toBeLessThan(30);
  });
