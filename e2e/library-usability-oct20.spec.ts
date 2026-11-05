import { openMyNotes } from "./helpers/notes-navigation";
import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { previewLibrary } from "../src/lib/preview-data";
let bundle: string;
test.beforeAll(async () => {
  bundle = (
    await build({
      entryPoints: ["e2e/harness.tsx"],
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
  await page.route("https://library.test/", (r: any) =>
    r.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html lang="ko"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>',
    }),
  );
  await page.goto("https://library.test/");
  await page.addStyleTag({ path: "src/app/globals.css" });
  await page.addScriptTag({ content: bundle });
}
for (const width of [390, 1440]) {
  test(`body-only memo, stable editor, unclassified filter and field search at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const notes = structuredClone(previewLibrary.notes);
    let created: any;
    await page.route("https://library.test/api/library", (r) => {
      if (r.request().method() === "GET")
        return r.fulfill({ json: { ...previewLibrary, notes } });
      created = r.request().postDataJSON();
      const id = crypto.randomUUID();
      notes.unshift({
        ...created.payload,
        id,
        title: created.payload.title || "미분류 메모",
        page: null,
        bookId: null,
        version: 1,
        createdAt: "2026-10-20T00:00:00Z",
        updatedAt: "2026-10-20T00:00:00Z",
      });
      return r.fulfill({ json: { id, version: 1 } });
    });
    await page.route("https://library.test/api/books?*", (r) => {
      const p = new URL(r.request().url()).searchParams;
      return r.fulfill({
        json: {
          items:
            p.get("publisher") === "김영사" ? [previewLibrary.books[0]] : [],
          total: p.get("publisher") === "김영사" ? 1 : 0,
        },
      });
    });
    await page.route("https://library.test/api/notes?*", (r) =>
      r.fulfill({
        json: {
          items: notes.filter((n) =>
            n.content.includes(
              new URL(r.request().url()).searchParams.get("content") || "",
            ),
          ),
          total: 1,
        },
      }),
    );
    await mount(page);
    await page.getByRole("button", { name: "메뉴 열기", exact: true }).click();
    await openMyNotes(page, { ...previewLibrary, notes });
    await page.getByRole("button", { name: "새 기록", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "새로운 기록" });
    await expect(
      dialog.getByLabel("제목", { exact: true }),
    ).not.toHaveAttribute("required");
    const before = await dialog.boundingBox();
    await dialog
      .getByLabel("내용", { exact: true })
      .fill("제목 없이 남기는 오늘의 질문");
    await expect(
      dialog.getByRole("button", { name: "기기에 임시 저장" }),
    ).toHaveCount(0);
    const after = await dialog.boundingBox();
    expect(Math.abs(before!.height - after!.height)).toBeLessThan(1);
    expect(Math.abs(before!.y - after!.y)).toBeLessThan(1);
    await dialog.getByRole("button", { name: "저장하기", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(created.payload.title).toBe("");
    await page.getByRole("button", { name: "메뉴 열기", exact: true }).click();
    await openMyNotes(page, { ...previewLibrary, notes });
    await expect(page.getByLabel("작성일 시작")).toHaveCount(0);
    await expect(page.getByLabel("작성일 끝")).toHaveCount(0);
    await page.getByRole("button", { name: "종류 선택", exact: true }).click();
    await page
      .getByRole("checkbox", { name: "미분류 메모", exact: true })
      .check();
    await page
      .getByRole("button", { name: "종류 선택 완료", exact: true })
      .click();
    await page
      .locator(".topic-material-filters")
      .getByRole("button", { name: "검색", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "미분류 메모", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "메뉴 열기", exact: true }).click();
    await page.getByRole("button", { name: "통합 검색", exact: true }).click();
    await page.getByRole("tab", { name: "도서 검색", exact: true }).click();
    const bookSearch = page.locator(".advanced-search");
    await bookSearch.getByLabel("출판사", { exact: true }).fill("김영사");
    await bookSearch.getByRole("button", { name: "검색", exact: true }).click();
    await expect(bookSearch.getByRole("status")).toHaveText("1개 결과");
    await page.getByRole("tab", { name: "메모 검색", exact: true }).click();
    const memoSearch = page.locator(".advanced-search");
    await memoSearch
      .getByLabel("메모 내용", { exact: true })
      .fill("오늘의 질문");
    await memoSearch.getByRole("button", { name: "검색", exact: true }).click();
    await expect(
      memoSearch.getByText("제목 없이 남기는 오늘의 질문", { exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
  test(`topic edit opens a visible window, removal restores and notes keep device page-size at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    let topics = [
        {
          id: crypto.randomUUID(),
          name: "독서",
          parentId: null,
          aliases: [],
          description: "기억",
          kdcCodes: [],
          confirmed: true,
          version: 1,
        },
      ],
      archivedTopics: any[] = [];
    await page.route("https://library.test/api/knowledge", (r) =>
      r.fulfill({
        json: { connections: [], research: [], items: [], placements: [] },
      }),
    );
    await page.route("https://library.test/api/assist", (r) =>
      r.fulfill({ json: { requests: [], policy: {}, usage: [], workers: [] } }),
    );
    await page.route("https://library.test/api/thought-map", (r) => {
      if (r.request().method() === "POST") {
        const c = r.request().postDataJSON();
        if (c.type === "upsertTopic")
          topics[0] = { ...topics[0], ...c.payload, version: 2 };
        if (c.type === "deleteTopic") {
          archivedTopics = topics.map((t) => ({
            ...t,
            version: t.version + 1,
            archivedAt: "2026-10-20T00:00:00Z",
          }));
          topics = [];
        }
        if (c.type === "restoreTopic") {
          topics = archivedTopics.map((t) => ({
            ...t,
            version: t.version + 1,
            archivedAt: null,
          }));
          archivedTopics = [];
        }
        return r.fulfill({ json: { ok: true } });
      }
      return r.fulfill({
        json: {
          topics,
          archivedTopics,
          memberships: [],
          topicLinks: [],
          events: previewLibrary.notes.map((n) => ({
            id: n.id,
            noteId: n.id,
            voice: "unconfirmed",
            occurredOn: null,
            dateSource: "unknown",
            version: 0,
          })),
          candidates: [],
          feedback: [],
        },
      });
    });
    await mount(page);
    await page.getByRole("button", { name: "메뉴 열기", exact: true }).click();
    await page
      .getByRole("button", { name: "사유의 지도", exact: true })
      .click();
    await page.getByRole("button", { name: "주제 관리", exact: true }).click();
    await page
      .getByRole("button", { name: "독서 주제 수정", exact: true })
      .click();
    const edit = page.getByRole("dialog", { name: "주제 수정" });
    await expect(edit).toBeVisible();
    await expect(edit.getByLabel("주제 이름", { exact: true })).toHaveValue(
      "독서",
    );
    await edit.getByLabel("주제 이름", { exact: true }).fill("독서와 기억");
    await edit.getByRole("button", { name: "주제 저장", exact: true }).click();
    await expect(edit).toHaveCount(0);
    await page
      .getByRole("button", { name: "독서와 기억 주제 삭제", exact: true })
      .click();
    await page.getByRole("button", { name: "주제 삭제", exact: true }).click();
    await page.getByText(/삭제한 주제 ·/).click();
    await page.getByRole("button", { name: "복원", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "독서와 기억 주제 수정", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "메모 상자", exact: true }).click();
    await page
      .getByLabel("내 기록 표시 개수", { exact: true })
      .selectOption("10");
    await expect(
      page.getByLabel("내 기록 표시 개수", { exact: true }),
    ).toHaveValue("10");
  });
}
