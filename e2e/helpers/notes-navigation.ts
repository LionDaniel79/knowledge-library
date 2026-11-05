import { build } from "esbuild";
import { previewLibrary } from "../../src/lib/preview-data";
import {
  buildTopicMaterials,
  pageTopicMaterials,
} from "../../src/lib/topic-materials";
import { expect, type Page } from "@playwright/test";
export async function openMyNotes(page: Page, library?: any) {
  if (library) {
    const state = {
      topics: [],
      memberships: [],
      topicLinks: [],
      notes: library.notes,
    };
    await page.route("**/api/thought-map", (r) =>
      r.request().method() === "GET"
        ? r.fulfill({ json: state })
        : r.fallback(),
    );
    await page.route("**/api/library-materials?*", (r) =>
      r.fulfill({
        json: pageTopicMaterials(
          buildTopicMaterials({
            books: library.books,
            notes: library.notes,
            topics: [],
            memberships: [],
          }),
          Object.fromEntries(new URL(r.request().url()).searchParams),
        ),
      }),
    );
  }

  const drawer = page.getByRole("dialog", { name: "서재 메뉴" });
  if (!(await drawer.isVisible()))
    await page.getByRole("button", { name: "메뉴 열기", exact: true }).click();
  await drawer
    .getByRole("button", { name: "사유의 지도", exact: true })
    .click();
  await page.getByRole("button", { name: "메모 상자", exact: true }).click();
  await page.getByRole("button", { name: "내 기록", exact: true }).click();
  await expect(page.locator(".topic-material-filters")).toBeVisible();
}
export async function openIntegratedSearch(page: Page) {
  await page.getByRole("button", { name: "메뉴 열기", exact: true }).click();
  await page
    .getByRole("dialog", { name: "서재 메뉴" })
    .getByRole("button", { name: "통합 검색", exact: true })
    .click();
  await page.getByRole("tab", { name: "통합 검색", exact: true }).click();
}

export async function mountPreviewFixture(page: Page) {
  await page.route("https://preview-fixture.test/", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div>',
    }),
  );
  await page.goto("https://preview-fixture.test/");
  await page.evaluate(
    (library) => ((window as any).fixture = library),
    previewLibrary,
  );
  await page.route("**/api/library", (r) =>
    r.fulfill({ json: previewLibrary }),
  );
  const script = (
    await build({
      stdin: {
        contents: `import{createRoot}from'react-dom/client';import{LibraryApp}from'./src/components/library-app';createRoot(document.getElementById('root')).render(<LibraryApp initial={window.fixture} today="2026-10-10"/>);`,
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
  await page.addStyleTag({ path: "src/app/globals.css" });
  await page.addScriptTag({ content: script });
}
export async function chooseNoteTags(page: Page, tags: string[]) {
  await page
    .getByRole("button", { name: "기록 태그 선택", exact: true })
    .click();
  for (const tag of tags) {
    await page
      .getByRole("searchbox", { name: "기록 태그 검색", exact: true })
      .fill(tag);
    await page.getByRole("button", { name: "태그 추가", exact: true }).click();
  }
  await page.getByRole("button", { name: "태그 적용", exact: true }).click();
}
