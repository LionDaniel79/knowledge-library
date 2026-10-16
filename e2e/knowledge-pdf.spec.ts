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
test("PDF progress distinguishes pending, unchecked OCR and stopped work on a narrow screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 900 });
  await page.route("https://library.test/api/pdf?*", (r) =>
    r.fulfill({
      json: {
        documents: [],
        total: 9309,
        summary: {
          total: 9309,
          basicOnly: 5243,
          states: { partial_ocr: 1, error: 7, changed: 1 },
          pages: 10,
          knownPages: 10,
          unavailablePages: 3,
          textPages: 7,
          pageMethods: {
            text: 5,
            ocr_unverified: 2,
            ocr_empty: 1,
            ocr_error: 1,
            needs_ocr: 1,
          },
          hashes: { stored: 5118, total: 9309 },
          workers: {
            ocr: { status: "paused", reason: "low_disk" },
            hash: { status: "stale" },
          },
        },
      },
    }),
  );
  await mount(page);
  await page.getByRole("button", { name: "메뉴 열기", exact: true }).click();
  await page
    .getByRole("button", { name: "PDF 원문 검색", exact: true })
    .click();
  await expect(
    page.getByRole("progressbar", { name: "PDF 본문 검색 준비" }),
  ).toHaveAttribute("value", "7");
  await expect(
    page.getByText("문자 인식: 저장 공간 부족으로 중단", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("문자 인식 · 원문 대조 전 2쪽", { exact: true }),
  ).not.toBeVisible();
  await page.getByText("자세한 처리 현황", { exact: true }).click();
  await expect(
    page.getByText("변경·오류로 검색에서 제외된 페이지 3쪽", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/파일 확인 필요 8개/)).toBeVisible();
  await expect(
    page.getByText("문자 인식 · 원문 대조 전 2쪽", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("빈 인식 결과 1쪽 · 인식 오류 1쪽 · 대기 1쪽", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("중복 확인 준비: 최근 응답 없음", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("PDF search keeps an exact page source and retries highlight saving with the same request", async ({
  page,
}) => {
  const doc = "00000000-0000-4000-a000-000000000001";
  let requests: string[] = [];
  await page.route("https://library.test/api/pdf?*", (r) =>
    r.fulfill({
      json: r.request().url().includes("mode=search")
        ? {
            hits: [
              {
                documentId: doc,
                title: "상담의 근거",
                pageNumber: 7,
                quote: "사람의 이야기를 듣는 상담",
                signature: "10:123",
              },
            ],
            summary: null,
          }
        : { documents: [], total: 0, summary: null },
    }),
  );
  await page.route("https://library.test/api/pdf/citation", (r) => {
    requests.push(r.request().postDataJSON().requestId);
    return r.fulfill({
      status: requests.length === 1 ? 503 : 200,
      json:
        requests.length === 1 ? { error: "잠시 후 다시 시도" } : { id: "note" },
    });
  });
  await page.route("https://library.test/api/library", (r) =>
    r.fulfill({ json: previewLibrary }),
  );
  await mount(page);
  await page.getByRole("button", { name: "메뉴 열기", exact: true }).click();
  await page
    .getByRole("button", { name: "PDF 원문 검색", exact: true })
    .click();
  await page.getByLabel("PDF 검색 범위").selectOption("search");
  await page.getByLabel("PDF 검색어", { exact: true }).fill("상담");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect(
    page.getByText("사람의 이야기를 듣는 상담", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "원문 페이지 열기" }),
  ).toHaveAttribute("href", `/reader/${doc}?page=7&signature=10%3A123`);
  await page.getByRole("button", { name: "하이라이트로 저장" }).click();
  await expect(page.getByRole("alert")).toContainText("잠시 후");
  await page.getByRole("button", { name: "하이라이트로 저장" }).click();
  await expect(page.getByRole("status")).toContainText("저장했습니다");
  expect(requests[0]).toBe(requests[1]);
});
test("connection decisions preserve explanations and offer sermon and thesis collections", async ({
  page,
}) => {
  const connection = {
    id: "link",
    source_kind: "note",
    source_id: previewLibrary.notes[0].id,
    target_kind: "book",
    target_id: previewLibrary.books[1].id,
    relation: "related",
    status: "suggested",
    reason: "공통 표현: 관계, 이해",
    version: 1,
  };
  await page.route("https://library.test/api/knowledge", (r) => {
    if (r.request().method() === "GET")
      return r.fulfill({
        json: { connections: [connection], research: [], items: [] },
      });
    const body = r.request().postDataJSON();
    if (body.type === "editConnection")
      Object.assign(connection, body.payload, { version: 2 });
    return r.fulfill({ json: { count: 1 } });
  });
  await mount(page);
  await page.getByRole("button", { name: "메뉴 열기", exact: true }).click();
  await page.getByRole("button", { name: "사유의 지도", exact: true }).click();
  await page.getByRole("button", { name: "사유의 연결", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "연결 이유", exact: true }),
  ).toHaveValue("공통 표현: 관계, 이해");
  await page.getByLabel("내 판단").selectOption("accepted");
  await page
    .getByRole("combobox", { name: "관계", exact: true })
    .last()
    .selectOption("supports");
  await page
    .getByRole("textbox", { name: "연결 이유", exact: true })
    .fill("관계에 관한 내 주장의 근거");
  await page.getByRole("button", { name: "판단·수정 저장" }).click();
  await page.getByRole("button", { name: /승인한 연결 1/ }).click();
  await expect(
    page.getByRole("textbox", { name: "연결 이유", exact: true }),
  ).toHaveValue("관계에 관한 내 주장의 근거");
  await page
    .getByRole("button", { name: "설교·논문 자료", exact: true })
    .click();
  await expect(page.getByLabel("용도")).toHaveValue("sermon");
  await page.getByLabel("용도").selectOption("thesis");
  await expect(page.getByLabel("용도")).toHaveValue("thesis");
});
test("all new endpoints reject an anonymous reader", async ({ request }) => {
  const id = "00000000-0000-4000-a000-000000000001";
  for (const path of [
    "/api/pdf?mode=list",
    "/api/knowledge",
    `/api/pdf/${id}/file`,
    `/api/pdf/${id}/page?page=1`,
    `/api/pdf/${id}/cover`,
  ])
    expect((await request.get(path)).status()).toBe(401);
});
test("OCR highlights require a reader's visual confirmation", async ({
  page,
}) => {
  let sent: any;
  await page.route("https://library.test/api/pdf?*", (r) =>
    r.fulfill({
      json: {
        hits: [
          {
            documentId: "00000000-0000-4000-a000-000000000001",
            title: "스캔 도서",
            pageNumber: 1,
            quote: "인식한 글자",
            signature: "1:2",
            extractionMethod: "ocr_unverified",
          },
        ],
        documents: [],
        total: 0,
        summary: null,
      },
    }),
  );
  await page.route("https://library.test/api/pdf/citation", (r) => {
    sent = r.request().postDataJSON();
    return r.fulfill({ json: { id: "note" } });
  });
  await page.route("https://library.test/api/library", (r) =>
    r.fulfill({ json: previewLibrary }),
  );
  await mount(page);
  await page.getByRole("button", { name: "메뉴 열기", exact: true }).click();
  await page
    .getByRole("button", { name: "PDF 원문 검색", exact: true })
    .click();
  await page.getByLabel("PDF 검색 범위").selectOption("search");
  await page.getByLabel("PDF 검색어", { exact: true }).fill("인식");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  const save = page.getByRole("button", { name: "하이라이트로 저장" });
  await expect(save).toBeDisabled();
  expect(sent).toBeUndefined();
  await page.getByLabel("문자 인식 결과를 원문 페이지와 대조했습니다.").check();
  await save.click();
  await expect(page.getByRole("status")).toContainText("저장했습니다");
  expect(sent.ocrConfirmed).toBe(true);
});
