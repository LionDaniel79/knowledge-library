import { test, expect, type Page } from "@playwright/test";
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
async function mount(page: Page) {
  await page.route("https://library.test/", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html lang="ko"><div id="root"></div></html>',
    }),
  );
  await page.goto("https://library.test/");
  await page.addStyleTag({ path: "src/app/globals.css" });
  await page.addScriptTag({ content: bundle });
}
test("connected memo edits preserve reasons and writing bundles replace retired research menus", async ({
  page,
}) => {
  const connection = {
    id: crypto.randomUUID(),
    source_kind: "note",
    source_id: previewLibrary.notes[0].id,
    target_kind: "note",
    target_id: previewLibrary.notes[1].id,
    relation: "related",
    status: "accepted",
    reason: "공통 표현: 관계, 이해",
    version: 1,
  };
  await page.route("https://library.test/api/whiteboard", (r) =>
    r.fulfill({
      json: {
        board: null,
        notes: previewLibrary.notes,
        books: previewLibrary.books,
        topics: [],
        memberships: [],
        bundles: [],
        bundleLinks: [],
        connections: [connection],
      },
    }),
  );
  await page.route("https://library.test/api/knowledge", (r) => {
    const c = r.request().postDataJSON();
    expect(c.type).toBe("editConnection");
    Object.assign(connection, c.payload, { version: 2 });
    return r.fulfill({ json: { id: connection.id, version: 2 } });
  });
  await mount(page);
  await page.getByRole("button", { name: "메뉴 열기", exact: true }).click();
  await page.getByRole("button", { name: "사유의 지도", exact: true }).click();
  await page.getByRole("button", { name: "연결된 메모", exact: true }).click();
  await page.locator(".memo-box-list button").first().click();
  const reason = page.getByRole("textbox", { name: "연결 이유", exact: true });
  await expect(reason).toHaveValue("공통 표현: 관계, 이해");
  await page
    .getByRole("combobox", { name: "관계", exact: true })
    .selectOption("supports");
  await reason.fill("관계에 관한 내 주장의 근거");
  await page
    .getByRole("button", { name: "연결 수정 저장", exact: true })
    .click();
  await expect.poll(() => connection.reason).toBe("관계에 관한 내 주장의 근거");
  expect(connection.relation).toBe("supports");
  await expect(
    page.getByRole("button", { name: "글감묶음", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "설교·논문 자료", exact: true }),
  ).toHaveCount(0);
});
test("retired originals expose no private data while knowledge endpoints still require login", async ({
  request,
}) => {
  const id = "00000000-0000-4000-a000-000000000001";
  for (const path of [
    "/api/pdf?mode=list",
    `/api/pdf/${id}/file`,
    `/api/pdf/${id}/page?page=1`,
    `/api/pdf/${id}/cover`,
  ])
    expect((await request.get(path)).status()).toBe(410);
  expect((await request.get("/api/knowledge")).status()).toBe(401);
});
