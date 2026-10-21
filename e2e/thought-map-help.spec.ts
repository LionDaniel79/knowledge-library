import { test, expect } from "@playwright/test";
import { build } from "esbuild";
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
for (const width of [360, 1440]) {
  test(`thought map help preserves drafts, costs no requests and fits ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    let requests = 0;
    await page.route("https://library.test/api/**", (r) => {
      requests++;
      const isMap = r.request().url().includes("/thought-map");
      return r.fulfill({
        json: isMap
          ? {
              topics: [],
              memberships: [],
              topicLinks: [],
              events: [],
              candidates: [],
              feedback: [],
            }
          : { connections: [], research: [], items: [], placements: [] },
      });
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
      .getByRole("button", { name: "사유의 지도", exact: true })
      .click();
    if (width <= 760)
      await page
        .getByRole("button", { name: "주제 관리", exact: true })
        .click();
    await page.getByText("주제 만들기·수정", { exact: true }).click();
    const draft = page.getByLabel("주제 이름", { exact: true });
    await draft.fill("작성 중인 공감 주제");
    await page
      .getByRole("dialog", { name: "주제 만들기" })
      .getByRole("button", { name: "닫기", exact: true })
      .click();
    const help = page.getByRole("button", { name: "사용법", exact: true });
    const before = requests;
    await help.click();
    const dialog = page.getByRole("dialog", { name: "사유의 지도 사용법" });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("heading", { name: "처음에는 이렇게 시작하세요" }),
    ).toBeVisible();
    await dialog
      .getByText("4. 시간에 따른 생각의 변화 남기기", { exact: true })
      .click();
    await expect(
      dialog.getByText("내 생각의 변화를 직접 연결", { exact: true }),
    ).toBeVisible();
    await dialog.getByText("6. 자동 기능과 AI의 범위", { exact: true }).click();
    await expect(
      dialog.getByText(/전체 서재의 자동 분석이나 자동 확정은 하지 않습니다/),
    ).toBeVisible();
    expect(
      await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(help).toBeFocused();
    expect(requests).toBe(before);
    await help.click();
    await dialog.getByRole("button", { name: "닫기", exact: true }).click();
    await page.getByText("주제 만들기·수정", { exact: true }).click();
    await expect(draft).toHaveValue("작성 중인 공감 주제");
  });
}
