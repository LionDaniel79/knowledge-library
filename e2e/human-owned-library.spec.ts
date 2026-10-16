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
for (const width of [360, 1440])
  test(`write, search and inspect provenance without an AI request at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const state = structuredClone(previewLibrary);
    let aiCalls = 0,
      hidden = false;
    page.on("request", (r) => {
      if (/\/api\/(assist|thought-jobs|thought-worker)/.test(r.url()))
        aiCalls++;
    });
    await page.route("https://library.test/api/library", (r) => {
      if (r.request().method() === "POST") {
        const p = r.request().postDataJSON().payload;
        state.notes.push({
          ...p,
          id: "new-note",
          version: 1,
          bookId: null,
          page: null,
          createdAt: "2026-10-13T10:00:00Z",
          updatedAt: "2026-10-13T10:00:00Z",
        });
        return r.fulfill({ json: { id: "new-note", version: 1 } });
      }
      return r.fulfill({ json: state });
    });
    await page.route("https://library.test/api/library-search?*", (r) =>
      r.fulfill({
        json: {
          items: [
            {
              id: "n:new-note",
              source: { kind: "note", id: "new-note", version: "1" },
              layer: "mine",
              title: "내가 생각한 관계",
              quote: "감정은 관계 속에서 이해한다.",
              coverage: "full",
              origin: "original",
              voice: "self",
            },
          ],
          nextCursor: null,
        },
      }),
    );
    await page.route("https://library.test/api/curation?*", (r) =>
      r.fulfill({
        json: {
          version: "1",
          items: [
            {
              id: "aux",
              kind: "tag",
              value: "관계",
              evidence: { quote: "관계 속에서" },
              coverage: "partial",
              origin: "codex",
              generator: "dev",
              state: hidden ? "hidden" : "active",
              source_version: "1",
              version: 1,
            },
          ],
          references: [],
          history: [],
        },
      }),
    );
    await page.route("https://library.test/api/curation", (r) => {
      hidden = true;
      return r.fulfill({ json: { ok: true } });
    });
    await page.route("https://library.test/", (r) =>
      r.fulfill({
        contentType: "text/html",
        body: '<!doctype html><html lang="ko"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>',
      }),
    );
    await page.goto("https://library.test/");
    await page.addStyleTag({ path: "src/app/globals.css" });
    await page.addScriptTag({ content: bundle });
    await page.getByRole("button", { name: "메뉴 열기", exact: true }).click();
    await page
      .getByRole("button", { name: "기록과 생각", exact: true })
      .click();
    await page
      .getByRole("button", { name: "새 기록", exact: true })
      .first()
      .click();
    await expect(
      page.getByRole("textbox", { name: "내용", exact: true }),
    ).toBeEmpty();
    await page
      .getByRole("textbox", { name: "제목", exact: true })
      .fill("내가 생각한 관계");
    await page
      .getByRole("textbox", { name: "내용", exact: true })
      .fill("감정은 관계 속에서 이해한다.");
    await page.getByLabel("태그", { exact: true }).fill("감정, 관계");
    await page.getByRole("button", { name: "저장하기", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("button", { name: "메뉴 열기", exact: true }).click();
    await page.getByRole("button", { name: "통합 검색", exact: true }).click();
    await page.getByLabel("자료 검색어").fill("감정");
    await page.getByLabel("검색 대상").selectOption("mine");
    await page.getByRole("button", { name: "자료 찾기", exact: true }).click();
    await expect(
      page.getByText("감정은 관계 속에서 이해한다.", { exact: true }),
    ).toBeVisible();
    await expect(page.locator(".search-hit-list details")).not.toHaveAttribute(
      "open",
      "",
    );
    expect(
      await page.evaluate(() =>
        [...document.querySelectorAll("main *")]
          .filter((e) => e.getBoundingClientRect().right > innerWidth + 1)
          .map((e) => ({
            tag: e.tagName,
            cls: e.className,
            right: e.getBoundingClientRect().right,
          })),
      ),
    ).toEqual([]);
    await page
      .getByRole("button", { name: "내가 생각한 관계", exact: true })
      .click();
    await page.getByText("검색을 위한 정리 정보", { exact: true }).click();
    await expect(page.locator(".curation-item details")).not.toHaveAttribute(
      "open",
      "",
    );
    await page.getByRole("button", { name: "숨기기", exact: true }).click();
    await expect(
      page.getByRole("textbox", { name: "내용", exact: true }),
    ).toHaveValue("감정은 관계 속에서 이해한다.");
    expect(aiCalls).toBe(0);
    await page
      .getByRole("button", { name: "닫기", exact: true })
      .last()
      .click();
    let connection: any;
    await page.route("https://library.test/api/knowledge", (r) =>
      r.fulfill({ json: { connections: [], research: [], items: [] } }),
    );
    await page.route("https://library.test/api/thought-map", (r) => {
      if (r.request().method() === "POST") {
        connection = r.request().postDataJSON();
        return r.fulfill({ json: { id: "connection" } });
      }
      return r.fulfill({
        json: {
          topics: [],
          memberships: [],
          topicLinks: [],
          candidates: [],
          feedback: [],
          events: state.notes.map((n, i) => ({
            id: n.id,
            noteId: n.id,
            voice: "self",
            occurredOn: i === 0 ? "2026-10-01" : "2026-10-13",
            dateSource: "user",
            version: 1,
          })),
        },
      });
    });
    await page.getByRole("button", { name: "메뉴 열기", exact: true }).click();
    await page
      .getByRole("button", { name: "사유의 지도", exact: true })
      .click();
    await page
      .getByRole("button", { name: "생각의 흐름", exact: true })
      .click();
    await page.getByText("내 생각의 변화를 직접 연결", { exact: true }).click();
    await page
      .getByRole("combobox", { name: "이전 생각", exact: true })
      .selectOption(state.notes[0].id);
    await page
      .getByRole("combobox", { name: "이후 생각", exact: true })
      .selectOption("new-note");
    await page
      .getByLabel("내가 판단한 이유", { exact: true })
      .fill("관계 속에서 감정을 이해하는 쪽으로 생각이 넓어졌다.");
    await page
      .getByRole("button", { name: "변화 연결 확정", exact: true })
      .click();
    await expect(
      page.getByText("판단과 수정 이력을 저장했습니다.", { exact: true }),
    ).toBeVisible();
    expect(connection.type).toBe("connectThoughts");
    expect(connection.payload.explanation).toContain("생각이 넓어졌다");
    expect(aiCalls).toBe(0);
  });
test("new search and curation routes require an owner", async ({ request }) => {
  for (const url of [
    "/api/books?q=test",
    "/api/books/00000000-0000-4000-a000-000000000001",
    "/api/backup",
    "/api/library-search?text=test",
    "/api/curation?kind=book&id=00000000-0000-4000-a000-000000000001",
  ])
    expect((await request.get(url)).status()).toBe(401);
});
