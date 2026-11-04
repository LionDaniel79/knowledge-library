import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { pageTopicMaterials } from "../src/lib/topic-materials";

let bundle: string;
test.beforeAll(async () => {
  bundle = (
    await build({
      stdin: {
        contents: `import {createRoot} from 'react-dom/client';import {TopicBrowser} from './src/components/thought-map/topic-browser';const root=createRoot(document.getElementById('root'));let revision=0;window.remountTopics=()=>root.render(<div className="thought-panel"><header style={{height:220}}>사유의 지도</header><TopicBrowser key={revision++} {...window.fixture} ownerId={window.fixtureOwner ?? "topic-fixture"} send={async()=>true} busy={false} onOpen={(kind,id)=>{window.opened={kind,id}}}/></div>);window.remountTopics();`,
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
    noteType: "thought",
    tags: ["독서"],
    title: `내 생각 ${i + 1}`,
    text: "책을 읽고 내가 남긴 생각",
    category: i < 2 ? "200" : "100",
    createdAt: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
    updatedAt: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
    bookId: null,
    bookTitle: "",
    topicIds: i === 0 ? [topics[0].id] : [],
    topicNames: i === 0 ? [topics[0].name] : [],
    version: 1,
  }));
  const books = Array.from({ length: 35 }, (_, i) => ({
    id: crypto.randomUUID(),
    kind: "book",
    title: `소장 책 ${i + 1}`,
    text: "저자 · 출판사",
    category: "100",
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    bookId: null,
    bookTitle: `소장 책 ${i + 1}`,
    topicIds: i === 0 ? [topics[0].id] : [],
    topicNames: i === 0 ? [topics[0].name] : [],
    version: 1,
  }));
  const requests: URLSearchParams[] = [];
  await page.route("https://library.test/api/library-materials?*", (r) => {
    const p = new URL(r.request().url()).searchParams;
    requests.push(p);
    return r.fulfill({
      json: pageTopicMaterials(
        [...notes, ...books] as any,
        Object.fromEntries(p),
      ),
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
  return { requests, topics };
}

async function applyFilters(page: Page) {
  await page
    .locator(".topic-material-filters")
    .getByRole("button", { name: "검색", exact: true })
    .click();
}
async function toggleChoice(page: Page, group: string, choice: string) {
  await page
    .getByRole("button", { name: group + " 선택", exact: true })
    .click();
  await page.getByRole("checkbox", { name: choice, exact: true }).click();
  await page
    .getByRole("button", { name: group + " 선택 완료", exact: true })
    .click();
  await applyFilters(page);
}
test("my notes reset pagination when record kind or library field changes", async ({
  page,
}) => {
  const f = await mount(page);
  await expect(
    page.getByRole("button", { name: "종류 선택", exact: true }),
  ).toContainText("전체");
  await expect(page.locator(".thought-card")).toHaveCount(15);
  await page.getByRole("button", { name: "2페이지", exact: true }).click();
  await expect(page.locator(".thought-card")).toHaveCount(3);
  await toggleChoice(page, "도서 분야", "종교");
  await expect(page.locator(".thought-card")).toHaveCount(2);
  await expect(page.locator(".topic-material-count")).toHaveText("내 기록 2개");
  expect(f.requests.at(-1)?.get("offset")).toBe("0");
  await toggleChoice(page, "종류", "독서 메모");
  await expect(page.locator(".thought-card")).toHaveCount(0);
  await toggleChoice(page, "종류", "독서 메모");
  await toggleChoice(page, "종류", "나의 생각");
  await expect(page.locator(".thought-card")).toHaveCount(2);
  expect(f.requests.at(-1)?.get("kind")).toBe("note");
  expect(f.requests.at(-1)?.get("noteTypes")).toBe(JSON.stringify(["thought"]));
});
test("new search narrows the full note list and resets its page while preserving other filters", async ({
  page,
}) => {
  const f = await mount(page);
  await page.getByRole("button", { name: "2페이지", exact: true }).click();
  await page
    .getByPlaceholder("제목·내용 검색", { exact: true })
    .fill("내 생각 1");
  await applyFilters(page);
  await expect(page.locator(".thought-card")).toHaveCount(10);
  expect(f.requests.at(-1)?.get("offset")).toBe("0");
  expect(f.requests.at(-1)?.get("q")).toBe("내 생각 1");
  await page
    .getByRole("combobox", { name: "정렬", exact: true })
    .selectOption("oldest");
  await expect(page.locator(".thought-card").first()).toContainText(
    "내 생각 1",
  );
  await page
    .getByPlaceholder("제목·내용 검색", { exact: true })
    .fill("전혀없는검색어");
  await applyFilters(page);
  await expect(page.locator(".thought-card")).toHaveCount(0);
});

test("topic filter and five global sort options apply with kind and category", async ({
  page,
}) => {
  const f = await mount(page);
  await toggleChoice(page, "주제", f.topics[0].name);
  await expect(page.locator(".thought-card")).toHaveCount(1);
  await toggleChoice(page, "도서 분야", "종교");
  await expect(page.locator(".topic-material-count")).toHaveText("내 기록 1개");
  for (const sort of ["oldest", "newest", "category", "topic", "book"]) {
    await page
      .getByRole("combobox", { name: "정렬", exact: true })
      .selectOption(sort);
    await applyFilters(page);
    await expect.poll(() => f.requests.at(-1)?.get("sort")).toBe(sort);
    await expect(page.locator(".thought-card")).toHaveCount(1);
  }
});

test("compact topic management is last and its order survives reopening", async ({
  page,
}) => {
  await mount(page);
  await expect(page.locator(".thought-card")).toHaveCount(15);
  const manager = page.locator(".thought-topics");
  expect((await manager.boundingBox())!.y).toBeGreaterThan(
    (await page.locator(".thought-card").last().boundingBox())!.y,
  );
  expect((await manager.boundingBox())!.height).toBeLessThan(100);
  await page.getByRole("button", { name: "주제 관리", exact: true }).click();
  await page
    .getByRole("button", { name: "독서 주제 0 아래로", exact: true })
    .click();
  await expect(page.locator(".topic-row").first()).toContainText("독서 주제 1");
  await page.getByRole("button", { name: "주제 선택", exact: true }).click();
  const options = page
    .getByRole("listbox", { name: "주제 목록" })
    .getByRole("checkbox");
  await expect(options.nth(2)).toHaveAccessibleName("독서 주제 1");
  await expect(options.nth(3)).toHaveAccessibleName("독서 주제 0");
  await page.evaluate(() => (window as any).remountTopics());
  await page.getByRole("button", { name: "주제 관리", exact: true }).click();
  await expect(page.locator(".topic-row").first()).toContainText("독서 주제 1");
  await page.evaluate(() => {
    (window as any).fixtureOwner = "another-owner";
    (window as any).remountTopics();
  });
  await page.getByRole("button", { name: "주제 관리", exact: true }).click();
  await expect(page.locator(".topic-row").first()).toContainText("독서 주제 0");
});

for (const width of [390, 1440])
  test(`filter selects keep equal height and fit at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await mount(page);
    await expect(page.locator(".thought-card")).toHaveCount(15);
    const controls = page.locator(
      ".note-kind-filter .wb-facet-toggle, .note-category-filter .wb-facet-toggle, .topic-filter .wb-facet-toggle, .note-sort-filter select",
    );
    await expect(controls).toHaveCount(4);
    const heights = await controls.evaluateAll((es) =>
      es.map((e) => e.getBoundingClientRect().height),
    );
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1);
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(44);
    const field = (await controls.nth(1).boundingBox())!;
    const book = (await page
      .locator(".note-book-filter .wb-facet-toggle")
      .boundingBox())!;
    expect(Math.abs(field.y - book.y)).toBeLessThanOrEqual(1);
    expect(field.x).toBeLessThan(book.x);
    const topic = (await controls.nth(2).boundingBox())!;
    const tag = (await page.locator(".tag-filter summary").boundingBox())!;
    expect(Math.abs(topic.y - tag.y)).toBeLessThanOrEqual(1);
    expect(topic.x).toBeLessThan(tag.x);
    const size = (await page
      .getByRole("combobox", { name: "내 기록 표시 개수", exact: true })
      .boundingBox())!;
    expect(size.y).toBeGreaterThan(
      (await page.locator(".thought-card").last().boundingBox())!.y,
    );
    expect(
      await page.locator("body").evaluate((e) => e.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await page.screenshot({
      path: `test-results/topic-materials/filters-${width}.png`,
      fullPage: false,
    });
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
    await page.getByRole("button", { name: "주제 관리", exact: true }).click();
    await page
      .getByRole("button", { name: "독서 주제 39", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "독서 주제 39", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await toggleChoice(page, "주제", "독서 주제 39");
    await toggleChoice(page, "도서 분야", "종교");
    await expect(page.locator(".thought-card")).toHaveCount(2);
    const first = (await page.locator(".thought-card").first().boundingBox())!;
    const filter = (await page
      .locator(".topic-material-filters")
      .boundingBox())!;
    expect(first.y - (filter.y + filter.height)).toBeLessThan(100);
  });
