import { test, expect } from "@playwright/test";
test("left drawer opens, traps navigation and returns focus when dismissed", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/preview");
  await expect(page.getByRole("navigation", { name: "주 메뉴" })).toHaveCount(
    0,
  );
  const menu = page.getByRole("button", { name: "메뉴 열기" });
  await menu.click();
  const drawer = page.getByRole("dialog", { name: "서재 메뉴" });
  await expect(drawer).toBeVisible();
  await expect.poll(async () => (await drawer.boundingBox())?.x).toBe(0);
  const box = await drawer.boundingBox();
  expect(box!.width).toBeLessThan(390);
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(menu).toBeFocused();
  await menu.click();
  await page.getByRole("button", { name: /^소장 도서/ }).click();
  await expect(drawer).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "완독", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("book sorting, editor and shelves preserve existing bibliographic fields", async ({
  page,
}) => {
  await page.goto("/preview");
  await page.getByRole("button", { name: "메뉴 열기" }).click();
  await page.getByRole("button", { name: /^소장 도서/ }).click();
  await page.getByLabel("도서 정렬").selectOption("title");
  const titles = await page.locator(".shelf-card > strong").allTextContents();
  expect(titles).toEqual([...titles].sort((a, b) => a.localeCompare(b, "ko")));
  await page.getByRole("button", { name: /마음을 듣는 연습/ }).click();
  const provenance = page.locator("details.book-evidence");
  await expect(provenance).not.toHaveAttribute("open", "");
  await expect(
    provenance.getByText("분류 출처", { exact: true }),
  ).not.toBeVisible();
  await provenance.locator("summary").click();
  await expect(
    provenance.getByText("분류 출처", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("책 대기열", { exact: true })).toBeVisible();
  await expect(
    page.getByLabel("내 인생 최고의 책들", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "수정", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("dialog", { name: "책 정보 수정" }),
  ).toBeVisible();
  await expect(page.getByLabel("책 제목")).toHaveValue("마음을 듣는 연습");
  await expect(page.getByLabel("저자", { exact: true })).toHaveValue("이마음");
  await page
    .getByRole("combobox", { name: "책 분야", exact: true })
    .selectOption("100");
  await page.getByLabel("책 대기열", { exact: true }).check();
  await expect(page.getByLabel("종이책", { exact: true })).toBeChecked();
});
test("calendar previews fill fixed cells and note filters remain usable with search", async ({
  page,
}) => {
  await page.goto("/preview");
  const cell = page.getByRole("button", { name: "2026-10-09", exact: true }),
    cover = cell.locator(".calendar-cover");
  const cb = await cell.boundingBox(),
    ib = await cover.boundingBox();
  expect(ib!.height).toBeGreaterThan(cb!.height - 6);
  expect(ib!.height).toBeLessThanOrEqual(cb!.height);
  await page.getByRole("button", { name: "메뉴 열기" }).click();
  await page.getByRole("button", { name: "기록과 생각", exact: true }).click();
  await page
    .getByRole("combobox", { name: "종류", exact: true })
    .selectOption("thought");
  await page.getByRole("textbox", { name: "서재 검색" }).fill("질문");
  await expect(page.getByLabel("기록 태그 필터")).toBeVisible();
  await expect(page.getByTestId("search-results")).toContainText(
    "답보다 오래 남는 질문",
  );
  await page.getByRole("button", { name: "새 기록", exact: true }).click();
  await page.getByLabel("태그", { exact: true }).fill("질문, 독서");
  await expect(page.getByLabel("태그", { exact: true })).toHaveValue(
    "질문, 독서",
  );
});
