import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { previewLibrary } from "../src/lib/preview-data";

test("import preview, retry and imported reading history are usable without counting unknown completions", async ({
  page,
}) => {
  const bundle = (
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
  await page.route("https://library.test/", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html lang="ko"><div id="root"></div></html>',
    }),
  );
  const imported = structuredClone(previewLibrary);
  imported.books[0].title = "가져온 전자책";
  imported.books[0].formats = ["ebook"];
  imported.books[0].sourceData = {
    app: "iReadItNow HD",
    libraryId: "test",
    recordId: "b1",
    raw: {},
    originalFormat: "전자책",
    statusCode: 16,
    sessions: [
      {
        sourceId: "s1",
        statusCode: 3,
        startedOn: "2020-01-01",
        endedOn: "2020-01-03",
        bookmarks: [{ sourceId: "m1", page: 42, recordedAt: null }],
        raw: {},
      },
    ],
  };
  let applied = 0;
  await page.route("https://library.test/api/import", (r) => {
    const { action } = r.request().postDataJSON();
    if (action === "apply" && ++applied === 1)
      return r.fulfill({
        status: 503,
        json: { error: "잠시 후 다시 시도해 주세요." },
      });
    return r.fulfill({
      json: {
        totalBooks: 1,
        totalNotes: 0,
        addedBooks: 1,
        addedNotes: 0,
        skippedBooks: 0,
        skippedNotes: 0,
        duplicateCandidates: 0,
        unknownFormats: 0,
        sourceSessions: 1,
      },
    });
  });
  await page.route("https://library.test/api/library", (r) =>
    r.fulfill({ json: imported }),
  );
  await page.goto("https://library.test/");
  await page.addStyleTag({ path: "src/app/globals.css" });
  await page.addScriptTag({ content: bundle });
  await page.getByRole("button", { name: "기존 자료 가져오기" }).click();
  await page.getByLabel("가져오기 파일").setInputFiles({
    name: "ireaditnow-library.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"source":"iReadItNowHD"}'),
  });
  const apply = page.getByRole("button", { name: "내 서재로 가져오기" });
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect(page.getByText("잠시 후 다시 시도해 주세요.")).toBeVisible();
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect(page.getByText("추가 완료: 책 1건 · 기록 0건")).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "닫기", exact: true })
    .last()
    .click();
  await page.getByRole("button", { name: "메뉴 열기", exact: true }).click();
  await page
    .getByRole("button", { name: /소장 도서/ })
    .first()
    .click();
  await page.getByRole("button", { name: "전자책", exact: true }).click();
  await page.getByRole("button", { name: /가져온 전자책/ }).click();
  await page.getByText("가져온 독서 이력 1회").click();
  await expect(page.getByText("독서 중단 · 원본 코드 3")).toBeVisible();
  await page.getByText("페이지 기록 1건").click();
  await expect(page.getByText("날짜 미기록 · 42쪽")).toBeVisible();
});

test("import and private images reject anonymous access", async ({
  request,
}) => {
  const imported = await request.post("/api/import", {
    headers: { origin: "http://127.0.0.1:3000" },
    data: { action: "apply", bundle: {} },
  });
  expect(imported.status()).toBe(401);
  const image = await request.get(
    "/api/import-assets/book/00000000-0000-5000-a000-000000000000",
  );
  expect(image.status()).toBe(401);
});
