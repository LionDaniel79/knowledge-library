import {
  openMyNotes,
  chooseNoteTags,
  openIntegratedSearch,
} from "./helpers/notes-navigation";
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
    await openMyNotes(page, state);
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
    await chooseNoteTags(page, ["감정", "관계"]);
    await page.getByRole("button", { name: "저장하기", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await openIntegratedSearch(page);
    await page.getByRole("searchbox", { name: "통합 검색어" }).fill("감정");
    await expect(
      page.getByText("감정은 관계 속에서 이해한다.", { exact: true }),
    ).toBeVisible();
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
    const connections: any[] = [];
    await page.route("https://library.test/api/thought-boxes", (r) =>
      r.fulfill({ json: { items: [] } }),
    );
    await page.route("https://library.test/api/whiteboard", (r) =>
      r.fulfill({
        json: {
          board: null,
          notes: state.notes,
          books: state.books,
          topics: [],
          memberships: [],
          bundles: [],
          bundleLinks: [],
          connections,
        },
      }),
    );
    await page.route("https://library.test/api/knowledge", (r) => {
      const c = r.request().postDataJSON();
      expect(c.type).toBe("connectWhiteboardNotes");
      connections.push({
        id: crypto.randomUUID(),
        source_kind: "note",
        source_id: c.payload.sourceId,
        target_kind: "note",
        target_id: c.payload.targetId,
        relation: "related",
        reason: "화이트보드에서 직접 연결",
        status: "accepted",
        version: 1,
      });
      return r.fulfill({
        json: { id: connections[0].id, version: 1, connection: connections[0] },
      });
    });
    await page.getByRole("button", { name: "메뉴 열기", exact: true }).click();
    await page
      .getByRole("dialog", { name: "서재 메뉴" })
      .getByRole("button", { name: "사유의 지도", exact: true })
      .click();
    await page.getByRole("button", { name: "화이트보드", exact: true }).click();
    const a = page.locator(`[data-note-id="${state.notes[0].id}"]`).first();
    const b = page.locator('[data-note-id="new-note"]').first();
    await a.focus();
    await a.press("Enter");
    await page
      .getByRole("button", { name: "선택한 메모 연결", exact: true })
      .click();
    await b.focus();
    await b.press("Enter");
    await expect.poll(() => connections.length).toBe(1);
    expect([connections[0].source_id, connections[0].target_id]).toEqual(
      expect.arrayContaining([state.notes[0].id, "new-note"]),
    );
    expect(aiCalls).toBe(0);
  });
test("new search and curation routes require an owner", async ({ request }) => {
  for (const url of [
    "/api/books?q=test",
    "/api/books/00000000-0000-4000-a000-000000000001",
    "/api/backup",
    "/api/library-search?text=test",
    "/api/library-materials?q=test&limit=15",
    "/api/curation?kind=book&id=00000000-0000-4000-a000-000000000001",
  ])
    expect((await request.get(url)).status()).toBe(401);
});
