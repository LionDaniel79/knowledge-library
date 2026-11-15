import { test, expect } from "@playwright/test";
import { build } from "esbuild";
async function mount(page: any, source: string) {
  await page.route("https://library.test/", (r: any) =>
    r.fulfill({
      contentType: "text/html",
      body: '<html lang="ko"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root" style="max-width:560px;margin:auto;padding:16px"></div></html>',
    }),
  );
  await page.goto("https://library.test/");
  await page.addStyleTag({ path: "src/app/globals.css" });
  const b = await build({
    stdin: { contents: source, resolveDir: process.cwd(), loader: "tsx" },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  await page.addScriptTag({ content: b.outputFiles[0].text });
}
for (const width of [390, 610, 1280])
  test(`summary is a lined single-line table at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route("https://library.test/api/catalog-review**", (r: any) =>
      r.fulfill({
        json: r.request().url().includes("summary=1")
          ? {
              formats: ["paper", "logos", "ebook", "pdf"].map((format) => ({
                format,
                total: 4112,
                covers: 186,
                classified: 3784,
                verified: 85,
                reviewBooks: 3304,
                candidates: 13621,
                incomplete: 3990,
              })),
            }
          : { items: [], total: 0, nextOffset: null },
      }),
    );
    await mount(
      page,
      `import {createRoot} from 'react-dom/client';import {CatalogReviewPanel} from './src/components/catalog-review-panel';createRoot(document.getElementById('root')).render(<CatalogReviewPanel onChanged={async()=>{}}/>);`,
    );
    await expect(page.locator(".catalog-summary-table tbody tr")).toHaveCount(
      4,
    );
    expect(
      await page
        .locator(".catalog-summary-table th,.catalog-summary-table td")
        .evaluateAll((cells: any[]) =>
          cells.every(
            (c) =>
              getComputedStyle(c).whiteSpace === "nowrap" &&
              c.getBoundingClientRect().height < 40,
          ),
        ),
    ).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const link = page.getByRole("link", { name: "로고스 표지 후보 확인" });
    expect((await link.boundingBox())!.height).toBeLessThan(40);
    await page.screenshot({
      path: test.info().outputPath(`summary-${width}.png`),
    });
  });
test("cover selection saves without an edition checkbox and failure allows retry", async ({
  page,
}) => {
  let posts: any[] = [];
  await page.route("https://library.test/api/logos/covers**", (r: any) => {
    if (r.request().method() === "POST") {
      posts.push(r.request().postDataJSON());
      return r.fulfill({
        status: posts.length === 1 ? 503 : 200,
        json: posts.length === 1 ? { error: "일시적 저장 오류" } : {},
      });
    }
    return r.fulfill({
      json: {
        items: [
          {
            id: "00000000-0000-4000-a000-000000000001",
            version: 7,
            title: "표지 검수 도서",
            author: "저자",
            candidates: [
              {
                isbn: "9780306406157",
                facts: {
                  title: "표지 검수 도서",
                  author: "저자",
                  publisher: "출판사",
                  coverUrl: "https://images.test/cover.png",
                },
              },
            ],
          },
        ],
        nextOffset: null,
      },
    });
  });
  await page.route("https://images.test/**", (r: any) =>
    r.fulfill({ status: 204 }),
  );
  await mount(
    page,
    `import {createRoot} from 'react-dom/client';import Page from './src/app/logos/covers/page';createRoot(document.getElementById('root')).render(<Page/>);`,
  );
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  const save = page.getByRole("button", { name: "표지 저장", exact: true });
  await expect(save).toBeDisabled();
  await page.getByRole("radio").check();
  await expect(save).toBeEnabled();
  await save.click();
  await expect(
    page.getByRole("alert").filter({ hasText: "일시적 저장 오류" }),
  ).toBeVisible();
  await save.click();
  await expect(page.getByRole("status")).toContainText("저장했습니다");
  expect(posts).toHaveLength(2);
  expect(posts[0]).toMatchObject({
    expectedVersion: 7,
    coverUrl: "https://images.test/cover.png",
    verification: "manual",
  });
  await expect(
    page.getByRole("navigation").getByRole("link", { name: "나의 서재" }),
  ).toHaveClass(/compact-link/);
});
test("import navigation uses compact buttons and shorter labels", async ({
  page,
}) => {
  await page.route("https://library.test/api/**", (r: any) =>
    r.fulfill({ json: { registrationEnabled: false } }),
  );
  await mount(
    page,
    `import {createRoot} from 'react-dom/client';import Page from './src/app/logos/import/page';createRoot(document.getElementById('root')).render(<Page/>);`,
  );
  const nav = page.getByRole("navigation");
  await expect(
    nav.getByRole("link", { name: "나의 서재", exact: true }),
  ).toHaveClass(/compact-link/);
  await expect(
    nav.getByRole("link", { name: "로고스 표지 확인", exact: true }),
  ).toHaveAttribute("href", "/logos/covers");
});
