import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
let bundle: string;
test.beforeAll(async () => {
  bundle = (
    await build({
      stdin: {
        contents:
          "import {createRoot} from 'react-dom/client';import {KnowledgePanel} from './src/components/knowledge-panel';createRoot(document.getElementById('root')).render(<KnowledgePanel library={window.fixture} onOpen={()=>{}}/>);",
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
  let mutations = 0;
  let readFailure = false;
  const book = {
    id: crypto.randomUUID(),
    title: "정서와 작업하기",
    author: "상담 저자",
    publisher: "출판사",
    version: 1,
    formats: ["paper"],
    tags: [],
    bookshelves: [],
  };
  const notes = Array.from({ length: 43 }, (_, i) => ({
    id: crypto.randomUUID(),
    bookId: book.id,
    title: i < 3 ? `최근 독서기록 ${i + 1}` : `과거 기록 ${i}`,
    content:
      i < 3 ? `새로 작성한 정서에 대한 생각 ${i + 1}` : "과거에 생각한 내용",
    kind: "note",
    page: null,
    tags: [],
    version: 1,
    createdAt: i < 3 ? `2026-10-${20 - i}T01:00:00Z` : "2018-01-01T00:00:00Z",
    updatedAt: "2026-10-20T01:00:00Z",
  }));
  let topics = Array.from({ length: 30 }, (_, i) => ({
    id: crypto.randomUUID(),
    name: i === 0 ? "정서" : `긴 이름의 개인 독서 주제 ${i}`,
    parentId: null,
    aliases: [],
    description: "",
    kdcCodes: [],
    confirmed: false,
    version: 1,
  }));
  let archivedTopics: any[] = [];
  const state = () => ({
    topics,
    archivedTopics,
    notes,
    memberships: notes.slice(0, 3).map((n) => ({
      id: crypto.randomUUID(),
      topicId: topics[0]?.id,
      sourceKind: "note",
      sourceId: n.id,
      sourceVersion: "1",
      status: "suggested",
      method: "tags",
      evidence: [],
      version: 1,
    })),
    topicLinks: [],
    events: notes.map((n) => ({
      id: n.id,
      noteId: n.id,
      occurredOn: n.createdAt.slice(0, 10),
      dateSource: "native",
      voice: "self",
      version: 0,
    })),
    candidates: [],
    feedback: [],
  });
  const library = {
    books: [book],
    notes: [notes[42]],
    cycles: [],
    catalog: {
      total: 1,
      formatCounts: { paper: 1, pdf: 0, ebook: 0, unknown: 0 },
      categoryCounts: {},
      firstPage: { items: [book], total: 1, nextCursor: null },
    },
  };
  await page.route("https://library.test/api/knowledge", (r) => {
    if (r.request().method() === "POST") mutations++;
    return r.fulfill({
      json: { connections: [], research: [], items: [], placements: [] },
    });
  });
  await page.route("https://library.test/api/assist", (r) =>
    r.fulfill({ json: { requests: [], policy: {}, usage: [], workers: [] } }),
  );
  await page.route("https://library.test/api/thought-map", (r) => {
    if (r.request().method() === "POST") {
      const c = r.request().postDataJSON();
      if (c.type === "deleteTopic") {
        const t = topics.find((t) => t.id === c.payload.id)!;
        archivedTopics.push({
          ...t,
          archivedAt: "2026-10-21T00:00:00Z",
          version: t.version + 1,
        });
        topics = topics.filter((t) => t.id !== c.payload.id);
      }
      if (c.type === "restoreTopic") {
        const t = archivedTopics.find((t) => t.id === c.payload.id);
        topics.push({ ...t, archivedAt: null, version: t.version + 1 });
        archivedTopics = archivedTopics.filter((t) => t.id !== c.payload.id);
      }
      return r.fulfill({ json: { ok: true } });
    }
    return r.fulfill(
      readFailure
        ? { status: 503, json: { error: "일시적인 조회 오류" } }
        : { json: state() },
    );
  });
  await page.route("https://library.test/api/library-materials?*", (r) => {
    const q = new URL(r.request().url()).searchParams.get("q") ?? "";
    const items =
      q === "없음"
        ? []
        : Array.from({ length: q ? 8 : 1 }, (_, i) => ({
            id: i === 0 ? book.id : crypto.randomUUID(),
            kind: "book",
            title: i === 0 ? book.title : `정서 자료 ${i + 1}`,
            text: "상담 저자 · 출판사",
            category: "100",
            version: 1,
          }));
    return r.fulfill({ json: { items, total: items.length } });
  });
  await page.route("https://library.test/", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="ko"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script>window.fixture=${JSON.stringify(library)}</script></html>`,
    }),
  );
  await page.goto("https://library.test/");
  await page.addStyleTag({ path: "src/app/globals.css" });
  await page.addScriptTag({ content: bundle });
  await expect(
    page.getByRole("heading", { name: "나의 주제", exact: true }),
  ).toBeVisible();
  return {
    book,
    notes,
    mutations: () => mutations,
    failReads: () => {
      readFailure = true;
    },
  };
}
test("opening the map only reads data instead of generating and saving connection candidates", async ({
  page,
}) => {
  const f = await mount(page);
  await expect(page.getByText("자료를 연결하고 있습니다…")).toHaveCount(0);
  expect(f.mutations()).toBe(0);
});
for (const width of [390, 1440])
  test(`topic removal is visible and reversible, with room for names at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await mount(page);
    if (width === 1440) {
      expect(
        (await page.locator(".thought-topics").boundingBox())!.width,
      ).toBeGreaterThanOrEqual(450);
      expect(
        (await page
          .getByRole("button", { name: "정서 주제 삭제", exact: true })
          .boundingBox())!.width,
      ).toBeLessThan(65);
    }
    await page
      .getByRole("button", { name: "정서 주제 삭제", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "주제 삭제 확인" });
    await expect(dialog).toBeVisible();
    const box = (await dialog.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(901);
    await dialog
      .getByRole("button", { name: "주제 삭제", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "정서 주제 삭제", exact: true }),
    ).toHaveCount(0);
    await page.getByText(/삭제한 주제 ·/).click();
    await page.getByRole("button", { name: "복원", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "정서 주제 삭제", exact: true }),
    ).toBeVisible();
  });
test("timeline includes proposed topics and the three newest full records before old pages", async ({
  page,
}) => {
  await mount(page);
  await page.getByRole("button", { name: "생각의 흐름", exact: true }).click();
  await expect(page.getByLabel("주제별 흐름").locator("option")).toHaveCount(
    31,
  );
  for (let i = 1; i <= 3; i++)
    await expect(
      page.getByRole("button", { name: `최근 독서기록 ${i}`, exact: true }),
    ).toBeVisible();
  await page.getByLabel("주제별 흐름").selectOption({ label: "정서 · 제안" });
  await expect(page.locator(".thought-event")).toHaveCount(3);
  await page.getByText("내 생각의 변화를 직접 연결", { exact: true }).click();
  await expect(
    page
      .getByRole("combobox", { name: "이전 생각", exact: true })
      .locator("option"),
  ).toHaveCount(1);
  await page
    .getByRole("combobox", { name: "기록 정렬", exact: true })
    .selectOption("oldest");
  await expect(
    page.locator(".thought-event .thought-title").first(),
  ).toHaveText("최근 독서기록 3");
});
test("refresh and a read error keep an unfinished date edit open", async ({
  page,
}) => {
  const f = await mount(page);
  await page.getByRole("button", { name: "생각의 흐름", exact: true }).click();
  const card = page.locator(".thought-event").first();
  await card.getByText("날짜·발화 주체·주제 수정", { exact: true }).click();
  const input = card.getByLabel("생각한 날짜", { exact: true });
  await input.fill("2026-10-17");
  await page
    .getByRole("button", { name: "지도 새로고침", exact: true })
    .click();
  await expect(input).toHaveValue("2026-10-17");
  await expect(input).toBeVisible();
  f.failReads();
  await page
    .getByRole("button", { name: "지도 새로고침", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("일시적인 조회 오류");
  await expect(input).toHaveValue("2026-10-17");
  await expect(input).toBeVisible();
});
test("connection search displays the eight selectable matches rather than hiding them in a select", async ({
  page,
}) => {
  const f = await mount(page);
  await page.getByRole("button", { name: "사유의 연결", exact: true }).click();
  await page.getByLabel("연결할 자료 찾기", { exact: true }).fill("정서");
  const results = page.getByRole("group", { name: "연결할 자료 검색 결과" });
  await expect(results.getByRole("button")).toHaveCount(8);
  await results
    .getByRole("button", { name: "책 · 정서와 작업하기", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "출발 자료", exact: true }),
  ).toHaveValue(`book:${f.book.id}`);
  await page.getByLabel("연결할 자료 찾기", { exact: true }).fill("없음");
  await expect(
    page.getByText("검색 결과가 없습니다.", { exact: true }),
  ).toBeVisible();
});
