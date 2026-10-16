import { test, expect } from "@playwright/test";

test("Google login replaces password signup and can retry a failed provider request", async ({
  page,
}) => {
  let attempts = 0;
  await page.route("**/api/auth/sign-in/social", async (route) => {
    expect(route.request().postDataJSON().provider).toBe("google");
    attempts++;
    await route.fulfill({
      status: 503,
      json: { message: "연결을 다시 시도해 주세요." },
    });
  });
  await page.goto("/");
  const button = page.getByRole("button", { name: "Google 계정으로 시작하기" });
  await expect(button).toBeVisible({ timeout: 3000 });
  await expect(
    page.locator('input[type="password"],input[type="email"]'),
  ).toHaveCount(0);
  await button.click();
  await expect(page.locator(".auth-card [role=alert]")).toBeVisible();
  await expect(button).toBeEnabled();
  await button.click();
  await expect.poll(() => attempts).toBe(2);
});
