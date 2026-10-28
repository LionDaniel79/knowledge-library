import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { previewLibrary } from "../src/lib/preview-data";
let bundle: string;
test.beforeAll(async () => {
  bundle = (
    await build({
      stdin: {
        contents: `import{createRoot}from'react-dom/client';import{useState}from'react';import{AdvancedSearch}from'./src/components/advanced-search';import{KnowledgePanel}from'./src/components/knowledge-panel';function App(){const[l,setL]=useState(window.fixture);const update=async()=>setL(old=>({...old,notes:[...old.notes]}));return window.mode==='search'?<AdvancedSearch mode="note" library={l} onOpen={()=>{}} onUpdated={update}/>:<KnowledgePanel library={l} onOpen={()=>{}} onUpdated={update}/>};createRoot(document.getElementById('root')).render(<App/>);`,
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
async function mount(page: Page, mode: string, holdInitialTopics = false) {
  const topics = [
    {
      id: crypto.randomUUID(),
      name: "공감",
      version: 7,
      confirmed: true,
      parentId: null,
      aliases: [],
      description: "",
      kdcCodes: [],
    },
  ];
  const notes = [
    {
      ...previewLibrary.notes[0],
      id: crypto.randomUUID(),
      bookId: null,
      title: "내 생각",
      content: "지켜야 할 나의 문장",
      tags: ["관계", "독서"],
      version: 1,
    },
  ];
  const calls: any[] = [],
    state = { rejectDelete: false };
  await page.route("https://library.test/api/**", async (r) => {
    const u = new URL(r.request().url());
    if (u.pathname === "/api/thought-map" && r.request().method() === "POST") {
      const c = r.request().postDataJSON();
      calls.push(c);
      if (c.type === "upsertTopic") {
        const t = {
          ...topics[0],
          ...c.payload,
          id: crypto.randomUUID(),
          version: 1,
        };
        topics.push(t);
        return r.fulfill({ json: { id: t.id, version: 1 } });
      }
      if (c.type === "deleteTopic") {
        if (state.rejectDelete)
          return r.fulfill({
            status: 409,
            json: { error: "다른 곳에서 수정되었습니다. 다시 확인해 주세요." },
          });
        const i = topics.findIndex((t) => t.id === c.payload.id);
        if (i >= 0) topics.splice(i, 1);
        return r.fulfill({ json: { id: c.payload.id, version: 8 } });
      }
    }
    if (u.pathname === "/api/thought-map")
      return r.fulfill({
        json: {
          topics,
          memberships: [],
          topicLinks: [],
          events: [],
          candidates: [],
          feedback: [],
          notes,
        },
      });
    if (u.pathname === "/api/library-search/topics" && holdInitialTopics)
      return;
    if (u.pathname === "/api/library-search/topics")
      return r.fulfill({ json: { topics } });
    if (u.pathname === "/api/note-tags") {
      if (r.request().method() === "POST") {
        const c = r.request().postDataJSON();
        calls.push({ tagDelete: c });
        for (const n of notes) n.tags = n.tags.filter((t) => t !== c.tag);
        return r.fulfill({ json: { count: 1 } });
      }
      return r.fulfill({
        json: notes[0].tags.map((tag) => ({
          tag,
          count: 1,
          activeCount: 1,
          fingerprint: tag + "-hash",
        })),
      });
    }
    if (u.pathname === "/api/notes") {
      calls.push({ search: Object.fromEntries(u.searchParams) });
      return r.fulfill({ json: { items: notes, total: notes.length } });
    }
    if (u.pathname === "/api/assist")
      return r.fulfill({
        json: { requests: [], policy: {}, usage: [], workers: [] },
      });
    return r.fulfill({ json: { items: [], total: 0 } });
  });
  await page.route("https://library.test/", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html lang="ko"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>',
    }),
  );
  await page.goto("https://library.test/");
  await page.evaluate(
    (f) => {
      Object.assign(window, f);
    },
    { fixture: { ...previewLibrary, books: [], notes, cycles: [] }, mode },
  );
  await page.addStyleTag({ path: "src/app/globals.css" });
  await page.addScriptTag({ content: bundle });
  return { topics, notes, calls, state };
}
for (const mode of ["search", "records"])
  test(`${mode} searches, creates and confirms topic and tag deletion without deleting notes`, async ({
    page,
  }) => {
    const f = await mount(page, mode);
    if (mode === "search")
      await page
        .getByRole("textbox", { name: "메모 내용", exact: true })
        .fill("유지할 검색 내용");
    if (mode === "records") {
      const rects = await page
        .locator(
          ".unified-notes-filters select, .unified-notes-filters .wb-facet-toggle, .unified-notes-filters .tag-filter summary, .unified-notes-filters .topic-material-search input",
        )
        .evaluateAll((es) =>
          es.map((e) => {
            const r = e.getBoundingClientRect();
            return { x: r.x, y: r.y, right: r.right, bottom: r.bottom };
          }),
        );
      for (let i = 0; i < rects.length; i++)
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i],
            b = rects[j];
          expect(
            Math.min(a.right, b.right) - Math.max(a.x, b.x) > 1 &&
              Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 1,
          ).toBe(false);
        }
    }
    await page.getByRole("button", { name: "주제 선택", exact: true }).click();
    const input = page.getByRole("textbox", { name: "주제 검색", exact: true });
    await input.fill("공");
    await expect(
      page.getByRole("option", { name: "공감", exact: true }),
    ).toBeVisible();
    await input.fill("새로운 주제");
    await expect(
      page.getByRole("option", { name: "공감", exact: true }),
    ).toHaveCount(0);
    await input.press("Enter");
    expect(f.calls.filter((c) => c.search)).toHaveLength(0);
    await expect(
      page.getByRole("button", { name: "주제 생성", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "주제 생성", exact: true }).click();
    await expect(
      page.getByRole("option", { name: "새로운 주제", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "주제 생성", exact: true }),
    ).toBeDisabled();
    await page
      .getByRole("option", { name: "새로운 주제", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "주제 선택", exact: true }),
    ).toContainText("새로운 주제");
    if (!(await input.isVisible()))
      await page
        .getByRole("button", { name: "주제 선택", exact: true })
        .click();
    await input.fill("공감");
    await page
      .getByRole("button", { name: "주제 삭제 공감", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "주제 삭제 확인",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    expect(f.calls.filter((c) => c.type === "deleteTopic")).toHaveLength(0);
    await dialog.getByRole("button", { name: "취소", exact: true }).click();
    expect(f.topics.some((t) => t.name === "공감")).toBe(true);
    await page.getByRole("button", { name: "주제 선택", exact: true }).click();
    await input.fill("공감");
    await page
      .getByRole("button", { name: "주제 삭제 공감", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "주제 삭제", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "주제 선택", exact: true }),
    ).toContainText("새로운 주제");
    if (mode === "search")
      await expect(
        page.getByRole("textbox", { name: "메모 내용", exact: true }),
      ).toHaveValue("유지할 검색 내용");
    expect(
      f.calls.find((c) => c.type === "deleteTopic").payload.expectedVersion,
    ).toBe(7);
    await page.getByRole("button", { name: "태그 선택", exact: true }).click();
    const tagInput = page.getByRole("searchbox", {
      name: "태그 검색",
      exact: true,
    });
    await tagInput.fill("관");
    await expect(
      page.getByRole("button", { name: "독서", exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "태그 삭제 관계", exact: true })
      .click();
    const tagDialog = page.getByRole("dialog", {
      name: "태그 삭제 확인",
      exact: true,
    });
    await expect(tagDialog).toBeVisible();
    expect(f.calls.filter((c) => c.tagDelete)).toHaveLength(0);
    await tagDialog.getByRole("button", { name: "취소", exact: true }).click();
    expect(f.notes[0].tags).toContain("관계");
    await page.getByRole("button", { name: "태그 선택", exact: true }).click();
    await tagInput.fill("관");
    await page
      .getByRole("button", { name: "태그 삭제 관계", exact: true })
      .click();
    await tagDialog
      .getByRole("button", { name: "태그 삭제", exact: true })
      .click();
    await expect(tagDialog).toHaveCount(0);
    expect(f.calls.find((c) => c.tagDelete).tagDelete).toMatchObject({
      tag: "관계",
      fingerprint: "관계-hash",
    });
    expect(f.notes[0].content).toBe("지켜야 할 나의 문장");
    await page.setViewportSize({ width: 1280, height: 844 });
    await page.getByRole("button", { name: "주제 선택", exact: true }).click();
    await expect(
      page.getByRole("textbox", { name: "주제 검색", exact: true }),
    ).toBeVisible();
    const popup = await page.locator(".wb-facet-popup").boundingBox();
    expect(popup!.x).toBeGreaterThanOrEqual(0);
    expect(popup!.x + popup!.width).toBeLessThanOrEqual(1280);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
test("keeps the topic and confirmation open when versioned deletion is rejected", async ({
  page,
}) => {
  const f = await mount(page, "search");
  f.state.rejectDelete = true;
  await page.getByRole("button", { name: "주제 선택", exact: true }).click();
  await page
    .getByRole("button", { name: "주제 삭제 공감", exact: true })
    .click();
  const d = page.getByRole("dialog", { name: "주제 삭제 확인", exact: true });
  await d.getByRole("button", { name: "주제 삭제", exact: true }).click();
  await expect(d.getByRole("alert")).toContainText("다른 곳에서 수정");
  expect(f.topics).toHaveLength(1);
  await d.getByRole("button", { name: "취소", exact: true }).click();
});
test("does not revive a newly created topic deleted before choices finish refreshing", async ({
  page,
}) => {
  await mount(page, "search");
  await page.getByRole("button", { name: "주제 선택", exact: true }).click();
  await expect(
    page.getByRole("option", { name: "공감", exact: true }),
  ).toBeVisible();
  await page.route("https://library.test/api/library-search/topics", () => {});
  await page
    .getByRole("textbox", { name: "주제 검색", exact: true })
    .fill("임시 주제");
  await page.getByRole("button", { name: "주제 생성", exact: true }).click();
  await expect(
    page.getByRole("option", { name: "임시 주제", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "주제 삭제 임시 주제", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "주제 삭제 확인",
    exact: true,
  });
  await dialog.getByRole("button", { name: "주제 삭제", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "주제 선택", exact: true }).click();
  await expect(
    page.getByRole("option", { name: "임시 주제", exact: true }),
  ).toHaveCount(0);
});
test("retains existing topics and blocks duplicate creation during a delayed refresh", async ({
  page,
}) => {
  await mount(page, "search");
  await page.getByRole("button", { name: "주제 선택", exact: true }).click();
  await expect(
    page.getByRole("option", { name: "공감", exact: true }),
  ).toBeVisible();
  await page.route("https://library.test/api/library-search/topics", () => {});
  const refresh = page.waitForRequest(
    "https://library.test/api/library-search/topics",
  );
  const input = page.getByRole("textbox", { name: "주제 검색", exact: true });
  await input.fill("새 주제");
  await page.getByRole("button", { name: "주제 생성", exact: true }).click();
  await refresh;
  await input.fill("공감");
  await expect(
    page.getByRole("option", { name: "공감", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "주제 생성", exact: true }),
  ).toBeDisabled();
});
test("waits for initial topic choices before enabling creation", async ({
  page,
}) => {
  await mount(page, "search", true);
  await page.getByRole("button", { name: "주제 선택", exact: true }).click();
  await page
    .getByRole("textbox", { name: "주제 검색", exact: true })
    .fill("공감");
  await expect(
    page.getByRole("button", { name: "주제 생성", exact: true }),
  ).toBeDisabled();
});
for (const mode of ["search", "records"])
  for (const width of [390, 1280])
    test(`tag dropdown matches its field and keeps circled removal in ${mode} at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await mount(page, mode);
      const toggle = page.getByRole("button", {
        name: "태그 선택",
        exact: true,
      });
      await toggle.click();
      const remove = page.getByRole("button", {
        name: "태그 삭제 관계",
        exact: true,
      });
      await expect(remove).toBeVisible();
      const field = (await toggle.boundingBox())!,
        popup = (await page.locator(".tag-dropdown").boundingBox())!;
      expect(Math.abs(popup.width - field.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(popup.x - field.x)).toBeLessThanOrEqual(1);
      await expect(remove).toHaveText("⊖");
      await page
        .getByRole("button", { name: "주제 선택", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "주제 삭제 공감", exact: true }),
      ).toHaveText("⊖");
    });

test("clears only the submitted topic or tag that was deleted", async ({
  page,
}) => {
  const f = await mount(page, "search");
  await page.getByRole("button", { name: "주제 선택", exact: true }).click();
  await page.getByRole("option", { name: "공감", exact: true }).click();
  await page.getByRole("button", { name: "태그 선택", exact: true }).click();
  await page.getByRole("button", { name: "관계", exact: true }).click();
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect
    .poll(() => f.calls.filter((c) => c.search).at(-1)?.search.topic)
    .toBe(f.topics[0].id);
  await page.getByRole("button", { name: "주제 선택", exact: true }).click();
  await page
    .getByRole("button", { name: "주제 삭제 공감", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "주제 삭제 확인", exact: true })
    .getByRole("button", { name: "주제 삭제", exact: true })
    .click();
  await expect
    .poll(() => f.calls.filter((c) => c.search).at(-1)?.search)
    .toMatchObject({ topic: "all", tag: "관계" });
  await page.getByRole("button", { name: "태그 선택", exact: true }).click();
  await page
    .getByRole("button", { name: "태그 삭제 관계", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "태그 삭제 확인", exact: true })
    .getByRole("button", { name: "태그 삭제", exact: true })
    .click();
  await expect
    .poll(() => f.calls.filter((c) => c.search).at(-1)?.search)
    .toMatchObject({ topic: "all", tag: "all" });
});
