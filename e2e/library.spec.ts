import { previewLibrary } from "../src/lib/preview-data";
import {
  openMyNotes,
  mountPreviewFixture,
  openIntegratedSearch,
} from "./helpers/notes-navigation";
import { test, expect } from "@playwright/test";
test("reading carousel stops at both ends and responds to mouse dragging", async ({
  page,
}) => {
  await mountPreviewFixture(page);
  const previous = page.getByRole("button", { name: "이전 책", exact: true }),
    next = page.getByRole("button", { name: "다음 책", exact: true });
  await expect(previous).toBeDisabled();
  for (let i = 0; i < 3; i++) await next.click();
  await expect(next).toBeDisabled();
  await expect(page.getByTestId("carousel-position")).toHaveText("4 / 4");
  await previous.click();
  await expect(next).toBeEnabled();
  await page.getByTestId("reading-carousel").scrollIntoViewIfNeeded();
  const area = await page.getByTestId("reading-carousel").boundingBox();
  if (!area) throw Error("Carousel not visible");
  await page.mouse.move(area.x + area.width * 0.7, area.y + 80);
  await page.mouse.down();
  await page.mouse.move(area.x + area.width * 0.25, area.y + 80, { steps: 8 });
  await page.mouse.up();
  await expect(next).toBeDisabled();
});
test("completion dates show their books and month navigation changes totals", async ({
  page,
}) => {
  await mountPreviewFixture(page);
  await expect(page.getByTestId("month-total")).toContainText("3");
  await page.getByRole("button", { name: "2026-10-09", exact: true }).click();
  await expect(page.getByTestId("selected-date-books")).toContainText(
    "읽는 삶",
  );
  await page.getByRole("button", { name: "이전 달", exact: true }).click();
  await expect(page.getByTestId("month-total")).toContainText("1");
});
test("preserves the selected reading card across navigation and search", async ({
  page,
}) => {
  await mountPreviewFixture(page);
  await page.getByRole("button", { name: "다음 책", exact: true }).click();
  await page.getByRole("button", { name: "메뉴 열기", exact: true }).click();
  await openMyNotes(page, previewLibrary);
  await page.getByRole("button", { name: "메뉴 열기", exact: true }).click();
  await page.getByRole("button", { name: "나의 서재", exact: true }).click();
  await expect(page.getByTestId("carousel-position")).toHaveText("2 / 4");
  await openIntegratedSearch(page);
  await page.getByPlaceholder("책, 저자, 내 생각을 검색하세요").fill("질문");
  await page.getByRole("button", { name: "검색 지우기" }).click();
  await page.getByRole("button", { name: "메뉴 열기", exact: true }).click();
  await page
    .getByRole("dialog", { name: "서재 메뉴" })
    .getByRole("button", { name: "나의 서재", exact: true })
    .click();
  await expect(page.getByTestId("carousel-position")).toHaveText("2 / 4");
});
test("search finds independent thoughts and mobile layout does not overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mountPreviewFixture(page);
  await openIntegratedSearch(page);
  await page.getByPlaceholder("책, 저자, 내 생각을 검색하세요").fill("질문");
  await expect(page.getByTestId("search-results")).toContainText(
    "답보다 오래 남는 질문",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
test("private APIs deny access without a configured authenticated session", async ({
  request,
}) => {
  const response = await request.get("/api/library");
  expect([401, 503]).toContain(response.status());
  expect(JSON.stringify(await response.json())).not.toContain("postgresql://");
});
test("finger swipes stop at either end on a mobile viewport", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  await page.goto("http://127.0.0.1:3000/preview");
  await page.getByTestId("reading-carousel").scrollIntoViewIfNeeded();
  const area = await page.getByTestId("reading-carousel").boundingBox();
  if (!area) throw Error("Missing carousel");
  const cdp = await context.newCDPSession(page);
  async function swipe(left: boolean) {
    const start = area!.x + area!.width * (left ? 0.75 : 0.25),
      end = area!.x + area!.width * (left ? 0.25 : 0.75),
      y = area!.y + 100;
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: start, y }],
    });
    for (let i = 1; i <= 6; i++)
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: start + ((end - start) * i) / 6, y }],
      });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  }
  await swipe(false);
  await expect(page.getByTestId("carousel-position")).toHaveText("1 / 4");
  for (let i = 0; i < 4; i++) await swipe(true);
  await expect(page.getByTestId("carousel-position")).toHaveText("4 / 4");
  await expect(
    page.getByRole("button", { name: "다음 책", exact: true }),
  ).toBeDisabled();
  await context.close();
});
test("book addition exposes paper/PDF and storage fields and preserves preview isolation", async ({
  page,
}) => {
  await page.goto("/preview");
  await page.getByRole("button", { name: "메뉴 열기", exact: true }).click();
  await page.getByRole("button", { name: /^소장 도서/ }).click();
  await page.getByRole("button", { name: "책 추가", exact: true }).click();
  await expect(page.getByLabel("종이책", { exact: true })).toBeChecked();
  await page.getByLabel("PDF", { exact: true }).check();
  await page.getByLabel("책 제목").fill("나의 첫 책");
  await page.getByLabel("보관 위치", { exact: true }).fill("서재 A-1");
  await page.getByRole("button", { name: "저장 안내 확인" }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "미리보기에서는 저장하지 않습니다",
  );
});
